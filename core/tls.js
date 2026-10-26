/**
 * Local certificate authority for the LAN HTTPS listener. Devices trust the
 * public CA once; server certificates are renewed under it without new trust.
 */
import "reflect-metadata";
import {
  BasicConstraintsExtension,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  SubjectKeyIdentifierExtension,
  X509CertificateGenerator,
} from "@peculiar/x509";
import { createPrivateKey, randomBytes, webcrypto, X509Certificate } from "node:crypto";
import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { certificateHosts } from "./net.js";

const CA_SUBJECT = "CN=VISTTA Code Hub Local CA";
const DAY = 86_400_000;
const ALGORITHM = {
  name: "RSASSA-PKCS1-v1_5",
  hash: "SHA-256",
  publicExponent: new Uint8Array([1, 0, 1]),
  modulusLength: 2048,
};

/**
 * Reasons a certificate is unsuitable for these hosts.
 * @param {string | Buffer} pem
 * @param {string[]} [hosts]
 */
export function certificateProblems(pem, hosts = certificateHosts()) {
  const certificate = new X509Certificate(pem);
  const problems = [];
  if (Date.parse(certificate.validFrom) > Date.now()) problems.push("not yet valid");
  if (Date.parse(certificate.validTo) < Date.now() + 30 * DAY) problems.push("expires within 30 days");
  for (const host of hosts) {
    if (!(isIP(host) ? certificate.checkIP(host) : certificate.checkHost(host))) problems.push(`missing address: ${host}`);
  }
  return problems;
}

function writePrivate(file, contents) {
  fs.writeFileSync(file, contents, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function validity(days) {
  return {
    serialNumber: "01" + randomBytes(19).toString("hex"),
    notBefore: new Date(Date.now() - 5 * 60_000),
    notAfter: new Date(Date.now() + days * DAY),
  };
}

/** @param {webcrypto.CryptoKey} key */
async function privatePem(key) {
  const der = await webcrypto.subtle.exportKey("pkcs8", key);
  return createPrivateKey({ key: Buffer.from(der), format: "der", type: "pkcs8" })
    .export({ format: "pem", type: "pkcs8" })
    .toString();
}

/**
 * Ensures a local CA and a server certificate covering `hosts` exist in `dir`.
 * Reuses a valid certificate; renews it (keeping the CA) when addresses change
 * or expiry approaches.
 * @param {string} dir
 * @param {{ days?: number, force?: boolean, hosts?: string[] }} [options]
 * @returns {Promise<{ cert: string, key: string, ca: string }>}
 */
export async function ensureLocalCa(dir, options = {}) {
  const days = options.days ?? 397;
  if (!Number.isInteger(days) || days < 1 || days > 3650)
    throw new Error("Certificate days must be an integer between 1 and 3650");
  const hosts = [...new Set(options.hosts ?? certificateHosts())];
  if (!hosts.length || hosts.some((host) => !isIP(host) && !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host)))
    throw new Error("Invalid certificate hosts");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files = {
    cert: path.join(dir, "https.crt"),
    key: path.join(dir, "https.key"),
    ca: path.join(dir, "rootCA.pem"),
  };
  const caKeyFile = path.join(dir, "rootCA-key.pem");
  let ca;
  let caKey;
  if (fs.existsSync(files.ca) || fs.existsSync(caKeyFile)) {
    if (!fs.existsSync(files.ca) || !fs.existsSync(caKeyFile))
      throw new Error("Local CA is incomplete; restore its certificate and private key from backup");
    ca = new X509Certificate(fs.readFileSync(files.ca));
    const privateKey = createPrivateKey(fs.readFileSync(caKeyFile));
    if (!ca.ca || !ca.checkPrivateKey(privateKey)) throw new Error("Local CA key does not match its certificate");
    if (Date.parse(ca.validFrom) > Date.now() || Date.parse(ca.validTo) < Date.now() + 31 * DAY)
      throw new Error("Local CA needs replacement; renew trust on each device before continuing");
    caKey = await webcrypto.subtle.importKey(
      "pkcs8",
      privateKey.export({ format: "der", type: "pkcs8" }),
      ALGORITHM,
      false,
      ["sign"],
    );
  } else {
    const keys = await webcrypto.subtle.generateKey(ALGORITHM, true, ["sign", "verify"]);
    caKey = keys.privateKey;
    const generated = await X509CertificateGenerator.createSelfSigned({
      ...validity(3650),
      name: CA_SUBJECT,
      keys,
      signingAlgorithm: ALGORITHM,
      extensions: [
        new BasicConstraintsExtension(true, 0, true),
        new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
        await SubjectKeyIdentifierExtension.create(keys.publicKey),
      ],
    });
    writePrivate(caKeyFile, await privatePem(caKey));
    fs.writeFileSync(files.ca, generated.toString("pem"));
    ca = new X509Certificate(fs.readFileSync(files.ca));
  }
  if (!options.force && fs.existsSync(files.cert) && fs.existsSync(files.key)) {
    try {
      const existing = new X509Certificate(fs.readFileSync(files.cert));
      if (
        !certificateProblems(existing.raw, hosts).length &&
        existing.verify(ca.publicKey) &&
        existing.checkPrivateKey(createPrivateKey(fs.readFileSync(files.key)))
      )
        return files;
    } catch {
      /* regenerate below */
    }
  }
  const keys = await webcrypto.subtle.generateKey(ALGORITHM, true, ["sign", "verify"]);
  const dates = validity(Math.min(days, 397));
  const certificate = await X509CertificateGenerator.create({
    ...dates,
    notAfter: new Date(Math.min(dates.notAfter.getTime(), Date.parse(ca.validTo))),
    subject: `CN=${hosts[0]}`,
    issuer: CA_SUBJECT,
    publicKey: keys.publicKey,
    signingKey: caKey,
    signingAlgorithm: ALGORITHM,
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature | KeyUsageFlags.keyEncipherment, true),
      new ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.1"]),
      new SubjectAlternativeNameExtension(hosts.map((host) => ({ type: isIP(host) ? "ip" : "dns", value: host }))),
    ],
  });
  writePrivate(files.key, await privatePem(keys.privateKey));
  fs.writeFileSync(files.cert, certificate.toString("pem"));
  return files;
}

/**
 * Resolves the LAN certificate: explicit files from config, or the managed
 * local CA. Returns the public CA (when it signed the certificate) for export.
 * @param {{ certFile?: string, keyFile?: string, days: number }} tls
 * @param {string} dir
 * @param {string} baseDir base for relative certificate paths
 */
export async function resolveCertificate(tls, dir, baseDir) {
  if (Boolean(tls.certFile) !== Boolean(tls.keyFile))
    throw new Error("TLS requires both certFile and keyFile, or neither for the managed local CA");
  const hosts = certificateHosts();
  const files =
    tls.certFile && tls.keyFile
      ? { cert: path.resolve(baseDir, tls.certFile), key: path.resolve(baseDir, tls.keyFile) }
      : await ensureLocalCa(dir, { days: tls.days, hosts });
  const certificate = fs.readFileSync(files.cert);
  let ca;
  for (const candidate of [path.join(dir, "rootCA.pem"), path.join(dir, "mkcert-rootCA.pem")]) {
    if (!fs.existsSync(candidate)) continue;
    const pem = fs.readFileSync(candidate);
    const authority = new X509Certificate(pem);
    if (authority.ca && new X509Certificate(certificate).verify(authority.publicKey)) {
      ca = { pem, fingerprint: authority.fingerprint256, file: candidate };
      break;
    }
  }
  return { cert: files.cert, key: files.key, problems: certificateProblems(certificate, hosts), ca };
}

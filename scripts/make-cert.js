/**
 * Creates (or renews) the local CA and the LAN server certificate, printing
 * the CA fingerprint so devices can verify what they trust.
 *
 * Usage: npm run cert [-- --force] [-- --days 365]
 */
import { X509Certificate } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { certificateHosts } from "../core/net.js";
import { dataDir as defaultDataDir } from "../core/paths.js";
import { certificateProblems, ensureLocalCa } from "../core/tls.js";

const args = process.argv.slice(2);
const force = args.includes("--force");
const days = (() => {
  const index = args.indexOf("--days");
  const value = index >= 0 ? Number(args[index + 1]) : NaN;
  return Number.isInteger(value) ? value : undefined;
})();

const dir = path.join(path.resolve(process.env.VCH_DATA_DIR || defaultDataDir()), "tls");
const files = await ensureLocalCa(dir, { days, force, hosts: certificateHosts() });
const certificate = new X509Certificate(files.ca);

console.log(`Local CA:      ${files.ca}`);
console.log(`Certificate:   ${files.cert}`);
console.log(`Private key:   ${files.key}`);
console.log(`CA SHA-256:    ${certificate.fingerprint256}`);
console.log(`CA valid:      ${certificate.validFrom} → ${certificate.validTo}`);
for (const problem of certificateProblems(files.cert, certificateHosts())) console.log(`Warning: ${problem}`);

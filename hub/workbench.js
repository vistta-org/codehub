/**
 * Patches code-server's browser workbench as it is served (the runtime on disk
 * is never modified):
 * - the Chat session index is mirrored to a server-side file, so every client
 *   lists, opens and continues the same sessions;
 * - a session log is appended only by the client that wrote its current
 *   version; otherwise the whole session is rewritten (last writer wins);
 * - Chat works with your own models without GitHub setup;
 * - the Code Hub web extension loads in every client;
 * - workspace storage is shared by local and LAN clients.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SHARED_INDEX_FILE = ".vch-shared-index";
export const EXTENSION_PATH = "/_vch/extension";
export const WORKBENCH_FILE = "lib/vscode/out/vs/code/browser/workbench/workbench.js";
const TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000;

function capture(source, pattern, label) {
  const match = pattern.exec(source);
  if (!match) throw new Error(`workbench anchor not found: ${label}`);
  if (pattern.exec(source.slice(match.index + match[0].length))) throw new Error(`workbench anchor is ambiguous: ${label}`);
  return match;
}

function replaceOnce(source, pattern, label, replacement) {
  const match = capture(source, pattern, label);
  return source.slice(0, match.index) + replacement(match) + source.slice(match.index + match[0].length);
}

/**
 * @param {string} source
 * @param {{ onSkip?: (label: string, error: Error) => void }} [options] optional
 *   chat-UI tweaks whose code is gone in this code-server version are skipped
 *   and reported here; the session-sharing patches always apply or throw.
 */
export function patchWorkbench(source, { onSkip } = {}) {
  capture(
    source,
    /async flushIndex\(\)\{let ([\w$]+)=this\.internalGetIndex\(\);try\{this\.storageService\.store\([\w$]+,\1,this\.getIndexStorageScope\(\),1\)/,
    "flushIndex",
  );
  const [, joinPath] = capture(
    source,
    /this\.storageRoot=[\w$]+\?([\w$]+)\(this\.userDataProfilesService\.defaultProfile\.globalStorageHome,"emptyWindowChatSessions"\)/,
    "storageRoot",
  );
  const [, buffer] = capture(source, /await this\.fileService\.writeFile\([\w$]+\.flat,([\w$]+)\.fromString\(/, "VSBuffer");

  const methods =
    `vchIndexUri(){return ${joinPath}(this.storageRoot,${JSON.stringify(SHARED_INDEX_FILE)})}` +
    `async vchSync(){try{let u=this.vchIndexUri(),l=this.internalGetIndex(),x="",s={entries:{},deleted:{}};` +
    `try{x=(await this.fileService.readFile(u)).value.toString();let p=JSON.parse(x);p&&typeof p.entries=="object"&&(s={entries:p.entries||{},deleted:p.deleted||{}})}catch{}` +
    `let n=Date.now(),d=s.deleted,t=v=>v?.lastMessageDate??0,m={},o={};` +
    `for(let k of this.vchDeleted??[])d[k]=n;this.vchDeleted=void 0;` +
    `for(let k of new Set([...Object.keys(s.entries),...Object.keys(l.entries)])){let a=l.entries[k],b=s.entries[k],v=a?b&&t(b)>t(a)?b:a:b;` +
    `v&&!(d[k]>=t(v))&&(m[k]=v,v.isExternal||(o[k]=v))}` +
    `for(let k of Object.keys(d))n-d[k]>${TOMBSTONE_MS}&&delete d[k];l.entries=m;` +
    `let y=JSON.stringify({version:1,entries:o,deleted:d});y!==x&&await this.fileService.writeFile(u,${buffer}.fromString(y))}` +
    `catch(e){this.logService.warn("Vistta Code Hub: shared chat index sync failed",e)}}` +
    `async vchOwns(u){try{let s=await this.fileService.stat(u);return(this.vchStamps??=new Map).get(u.toString())===s.etag}catch{return!1}}` +
    `vchStamp(u,s){(this.vchStamps??=new Map).set(u.toString(),s?.etag)}`;

  let out = source;
  out = replaceOnce(
    out,
    /getChatStorageFolder\(\)\{return this\.storageRoot\}/,
    "getChatStorageFolder",
    ([all]) => methods + all,
  );
  out = replaceOnce(
    out,
    /async getIndex\(\)\{return this\.storeQueue\.queue\(async\(\)=>this\.internalGetIndex\(\)\.entries\)\}/,
    "getIndex",
    () => "async getIndex(){return this.storeQueue.queue(async()=>(await this.vchSync(),this.internalGetIndex().entries))}",
  );
  out = replaceOnce(out, /async flushIndex\(\)\{/, "flushIndex", ([all]) => `${all}await this.vchSync();`);
  out = replaceOnce(
    out,
    /async internalDeleteSession\(([\w$]+)\)\{/,
    "internalDeleteSession",
    ([all, id]) => `${all}(this.vchDeleted??=new Set).add(${id});`,
  );
  out = replaceOnce(
    out,
    /([\w$]+)\.byteLength>0&&await this\.fileService\.writeFile\(([\w$]+)\.log,\1,\{append:([\w$]+)==="append"\}\),([\w$]+)\.dataSerializer\.confirmWrite\(\)/,
    "session log write",
    ([, data, location, op, model]) =>
      `if(${op}==="append"&&${data}.byteLength>0&&!await this.vchOwns(${location}.log)){${model}.dataSerializer._clearPending();${data}=${model}.dataSerializer.createInitial(${model});${op}="replace"}` +
      `${data}.byteLength>0&&this.vchStamp(${location}.log,await this.fileService.writeFile(${location}.log,${data},{append:${op}==="append"})),${model}.dataSerializer.confirmWrite()`,
  );
  // UI state (chat session list, model choices, workspace state) goes to the server's storage
  // channel instead of each browser's IndexedDB, so every client sees the same state.
  out = replaceOnce(
    out,
    /let ([\w$]+)=\{\.\.\.JSON\.parse\(([\w$]+)\),remoteAuthority:location\.host\}/,
    "web configuration",
    ([, config, settings]) =>
      `let ${config}={...JSON.parse(${settings}),remoteAuthority:location.host,remoteStorageEnabled:!0,` +
      `additionalBuiltinExtensions:[...(JSON.parse(${settings}).additionalBuiltinExtensions||[]),{scheme:location.protocol.slice(0,-1),authority:location.host,path:${JSON.stringify(EXTENSION_PATH)}}]}`,
  );
  // Workspace storage IDs hash the folder URI, whose authority is the address the client used.
  // Hash it as the host's loopback address so LAN and local clients share storage and chat sessions.
  out = replaceOnce(
    out,
    /function ([\w$]+)\(([\w$]+)\)\{return ([\w$]+)\(\2\.toString\(\)\)\.toString\(16\)\}/,
    "workspace storage id",
    ([, name, uri, hashFn]) =>
      `function ${name}(${uri}){if(${uri}.scheme==="vscode-remote"&&${uri}.authority===location.host&&window.__vchLocalAuthority)${uri}=${uri}.with({authority:window.__vchLocalAuthority});return ${hashFn}(${uri}.toString()).toString(16)}`,
  );
  // --- optional chat-UI tweaks: VS Code rewrites this code often ------------ //
  /** @param {string} label @param {(current: string) => string} apply */
  const optional = (label, apply) => {
    try {
      out = apply(out);
    } catch (error) {
      onSkip?.(label, /** @type {Error} */ (error));
    }
  };
  // The SCM sparkle otherwise opens GitHub setup before calling the commit generator.
  optional("SCM commit generation setup", (current) =>
    replaceOnce(
      current,
      /if\(!await ([\w$]+)\.executeCommand\(([\w$]+),\{telemetrySource:"scm"\}\)\)return;let ([\w$]+)=([\w$]+)\.defaultChatAgent\?\.generateCommitMessageCommand;/,
      "SCM commit generation setup",
      ([, , , command, product]) => `let ${command}=${product}.defaultChatAgent?.generateCommitMessageCommand;`,
    ),
  );
  // Own model providers (BYOK) are always allowed, so Manage Models never depends on a GitHub entitlement.
  optional("BYOK availability", (current) =>
    replaceOnce(
      current,
      /function ([\w$]+)\(([\w$]+)\)\{return \2\.clientByokEnabled\|\|\2\.hasByokModels\|\|/,
      "BYOK availability",
      ([all]) => all.replace("{return", "{return!0||"),
    ),
  );
  optional("model picker sign-in", (current) => {
    const icons = new Set(
      [
        ...current.matchAll(
          /\{item:[\w$]+\.manageModelsAction,kind:"action",label:[\w$]+\.manageModelsAction\.label,group:\{title:"",icon:([\w$]+)\.blank\}/g,
        ),
      ].map((match) => match[1]),
    );
    if (icons.size !== 1) throw new Error("workbench anchor not found: manage models icon");
    const [icon] = icons;
    return replaceOnce(
      current,
      /if\(([\w$]+)\)\{let [\w$]+=!!([\w$]+)\.actions\.onRequestSetup,/,
      "model picker sign-in",
      ([all, setup, picker]) =>
        `if(${setup}&&${picker}.manageModelsAction)return[{item:${picker}.manageModelsAction,kind:"action",label:${picker}.manageModelsAction.label,group:{title:"",icon:${icon}.gear},hideIcon:!1}];${all}`,
    );
  });
  // Deprecated providers (e.g. built-in Ollama) are replaced by bundled extensions.
  optional("deprecated model providers", (current) =>
    replaceOnce(
      current,
      /deprecation:([\w$]+)\.deprecation,when:\1\.when,/,
      "deprecated model providers",
      ([, vendor]) => `deprecation:${vendor}.deprecation,when:${vendor}.deprecation?"false":${vendor}.when,`,
    ),
  );
  // Chat never needs GitHub setup: only disabled AI or an untrusted workspace stop a request.
  optional("chat setup requirement", (current) =>
    replaceOnce(
      current,
      /function ([\w$]+)\(([\w$]+)\)\{return!\2\.completed&&!\2\.hasByokModels\|\|\2\.disabled\|\|\2\.untrusted\|\|[^}]*\}/,
      "chat setup requirement",
      ([, name, arg]) => `function ${name}(${arg}){return!!${arg}.disabled||!!${arg}.untrusted}`,
    ),
  );
  // The built-in chat extension provides the chat agents for own models, so a new profile must not disable it before setup.
  optional("chat extension enablement", (current) =>
    replaceOnce(
      current,
      /let ([\w$]+)=this\.chatEntitlementService\.context;if\(\1\)if\(\1\.value\.state\.completed\)/,
      "chat extension enablement",
      ([all, context]) => all.replace(`if(${context}.value.state.completed)`, "if(!0)"),
    ),
  );
  return out;
}

/**
 * Serves the patched workbench, re-patching when the runtime file changes.
 * @param {string} runtimeDirectory
 * @param {string} localAuthority loopback `host:port` every client hashes storage as
 * @param {import("../core/logger.js").Logger} logger
 */
export function createWorkbenchLoader(runtimeDirectory, localAuthority, logger) {
  let cached;
  return () => {
    const file = path.join(runtimeDirectory, WORKBENCH_FILE);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat) return undefined;
    const stamp = `${stat.size}:${stat.mtimeMs}:${localAuthority}`;
    if (cached?.stamp === stamp) return cached;
    const source = fs.readFileSync(file, "utf8");
    let body = source;
    let patched = false;
    try {
      const skipped = [];
      body = `window.__vchLocalAuthority=${JSON.stringify(localAuthority)};\n${patchWorkbench(source, {
        onSkip: (label) => skipped.push(label),
      })}`;
      patched = true;
      logger.info("app", "IDE workbench patched: shared chat sessions");
      if (skipped.length)
        logger.warn("app", `Chat UI tweaks not available in this code-server version: ${skipped.join(", ")}`);
    } catch (error) {
      logger.error(
        "app",
        `Shared chat sessions unavailable for this code-server version (${error.message}); serving the stock workbench`,
      );
    }
    const buffer = Buffer.from(body);
    cached = { stamp, body: buffer, etag: `"${createHash("sha256").update(buffer).digest("base64url")}"`, patched };
    return cached;
  };
}

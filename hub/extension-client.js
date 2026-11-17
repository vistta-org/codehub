// @ts-ignore - VS Code supplies this module to the web extension host at runtime.
const vscode = require("vscode");

exports.activate = (context) => {
  const origin = /^https?:\/\//.test(globalThis.location.origin) ? globalThis.location.origin : "http://127.0.0.1:8181";
  const endpoint = (path) => new URL(path, origin).toString();
  const settings = () => vscode.workspace.getConfiguration("codeHub");
  const hostSettings = [
    { setting: "startMinimized", section: "desktop", key: "startMinimized" },
    { setting: "hostName", key: "name" },
    { setting: "projectsRoot", section: "projects", key: "root" },
    { setting: "serverPort", section: "server", key: "port" },
    { setting: "idePort", section: "ide", key: "port" },
    { setting: "logLevel", section: "server", key: "logLevel" },
    { setting: "workspaceTrust", section: "ide", key: "workspaceTrust" },
  ];
  const openSettingsEditor = () => vscode.commands.executeCommand("workbench.action.openSettings", "@ext:vistta.code-hub");
  const item = vscode.window.createStatusBarItem("codeHub.sharing", vscode.StatusBarAlignment.Left, 1000);
  item.name = "Vistta Code Hub";
  item.command = "codeHub.menu";
  let state = { sharing: false, controllable: false, lanUrls: [] };
  let changing = 0;
  const notify = (error) => vscode.window.showErrorMessage("Vistta Code Hub: " + (error.message || String(error)));
  // An IDE opened from another device is refused host state (401/403); that is expected, not an error.
  const REMOTE = { sharing: false, controllable: false, lanUrls: [], remote: true };

  const request = async (path, method = "GET", body, quietWhenRemote = false) => {
    try {
      const response = await fetch(endpoint(path), {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(path.startsWith("/_vch/") || path.startsWith("/api/remotes") ? { "x-vch-request": "1" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
      });
      if (quietWhenRemote && (response.status === 401 || response.status === 403)) return REMOTE;
      const text = await response.text();
      const data = text ? JSON.parse(text) : {};
      if (!response.ok) throw new Error(data.error?.message || `HTTP ${response.status}`);
      return data;
    } catch (error) {
      void notify(error);
      return null;
    }
  };
  const refresh = async () => {
    const next = await request("/_vch/state", "GET", undefined, true);
    if (next) state = next;
    item.text = state.remote ? "$(remote) Code Hub" : state.sharing ? "$(broadcast) LAN" : "$(lock) Local only";
    item.tooltip = state.controllable ? "Vistta Code Hub options" : "Host controls are only available on the host IDE";
    item.color = state.sharing ? new vscode.ThemeColor("testing.iconPassed") : undefined;
    item.show();
    if (state.controllable && state.settingsRequested && vscode.window.state.focused) {
      const claimed = await request("/_vch/settings/claim", "POST");
      if (claimed?.open) {
        await syncSettings();
        await openSettingsEditor();
      }
    }
    if (state.controllable && state.pairingRequested && vscode.window.state.focused) {
      const claimed = await request("/_vch/pairing/claim", "POST");
      if (claimed?.open) await commands.pairDevice();
    }
    return !!next;
  };
  const syncSettings = async () => {
    if (!state.controllable || changing) return;
    changing++;
    try {
      const config = await request("/api/config");
      if (!config) return;
      /** @type {Record<string, string | number | boolean>} */
      const values = {
        shareOnLan: state.sharing,
        ...Object.fromEntries(
          hostSettings.map(({ setting, section, key }) => [setting, section ? config[section][key] : config[key]]),
        ),
      };
      if (state.desktop) {
        const startup = await request("/_vch/startup");
        if (startup) values.startAtLogin = startup.enabled;
      }
      for (const [key, value] of Object.entries(values)) {
        if (settings().get(key) !== value) await settings().update(key, value, vscode.ConfigurationTarget.Global);
      }
    } finally {
      changing--;
    }
  };
  const openSettings = async () => {
    if (await refresh()) await syncSettings();
    return openSettingsEditor();
  };
  const hostOnly = async () => {
    if (!(await refresh())) return false;
    if (state.controllable) return true;
    void vscode.window.showInformationMessage("Host controls are only available in the host IDE.");
    return false;
  };
  const confirm = async (message) =>
    (await vscode.window.showWarningMessage(message, { modal: true }, "Confirm")) === "Confirm";
  const action = (name) => async () => {
    if (await hostOnly()) await request("/_vch/host/" + name, "POST");
  };
  const remotePath = (remote, suffix = "") => "/api/remotes/" + encodeURIComponent(remote.id) + suffix;
  // The hub starts the remote IDE and its relay; the desktop app opens it in a window.
  const openRemote = async (remote) => {
    const opened = await request(remotePath(remote, "/open"), "POST", {});
    if (opened) await request("/_vch/host/openRemote", "POST", { id: remote.id, url: opened.url });
  };
  const remoteDetail = (status) =>
    !status
      ? ""
      : !status.online
        ? "Offline or not sharing"
        : !status.paired
          ? "No longer paired — forget it and add it again"
          : "IDE " + (status.status?.ide?.state || "unknown");

  const commands = {
    openSettings,
    toggleSharing: async () => {
      if (!(await hostOnly())) return;
      changing++;
      try {
        await request("/_vch/host/" + (state.sharing ? "stopSharing" : "share"), "POST");
      } finally {
        changing--;
        setTimeout(() => void refresh().then(syncSettings).catch(notify), 1500);
      }
    },
    pairDevice: async () => {
      if (!(await hostOnly())) return;
      const data = await request("/api/devices/pairing", "POST");
      if (!data) return;
      const { code, expiresAt } = data.pairing;
      const panel = vscode.window.createWebviewPanel("codeHub.pair", "Pair a Device", vscode.ViewColumn.Active);
      const escape = (value) =>
        String(value).replace(
          /[&<>"']/g,
          (char) =>
            ({
              "&": "&amp;",
              "<": "&lt;",
              ">": "&gt;",
              '"': "&quot;",
              "'": "&#39;",
            })[char],
        );
      panel.webview.html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
        <style>body{font-family:system-ui;padding:2rem;color:var(--vscode-foreground);background:var(--vscode-editor-background)}code{font-size:2rem}.link{font-size:1rem;word-break:break-all}a{color:var(--vscode-textLink-foreground)}</style>
        <h1>Pair a Device</h1><p>Code: <code>${escape(code)}</code></p>
        <p>Expires: ${escape(new Date(expiresAt).toLocaleTimeString())}</p>
        ${data.link ? `<p>Open this link in a browser, or scan it with the Vistta Code Hub app:</p><p><a class="link" href="${escape(data.link)}">${escape(data.link)}</a></p><img alt="Pairing QR" src="${data.qr}">` : "<p>Turn on Share on LAN to get a pairing link and QR code. You can also enter the host address and code manually in the app.</p>"}
        ${data.fingerprint ? `<p>Certificate SHA-256 (the other device shows this after pairing; it must match):<br><code style="font-size:1rem;word-break:break-all">${escape(data.fingerprint)}</code></p>` : ""}`;
      const choice = await vscode.window.showInformationMessage("Pairing code: " + code, "Copy Link", "Cancel Pairing");
      if (choice === "Copy Link") await vscode.env.clipboard.writeText(data.link || code);
      if (choice === "Cancel Pairing") await request("/api/devices/pairing", "DELETE");
    },
    projects: async () => {
      if (!(await hostOnly())) return;
      const projects = await request("/api/projects");
      if (!projects) return;
      const choice = await vscode.window.showQuickPick(
        [
          { label: "$(add) Create Project", action: "create" },
          ...projects.map((project) => ({
            label: "$(folder) " + project.name,
            description: project.path,
            project,
          })),
        ],
        { title: "Projects" },
      );
      if (!choice) return;
      if (choice.action === "create") {
        const name = await vscode.window.showInputBox({ prompt: "New project name" });
        if (name) await request("/api/projects", "POST", { name });
      } else {
        const opened = await request("/api/projects/open", "POST", { project: choice.project.path });
        if (!opened) return;
        const remotePath = opened.path.replace(/\\/g, "/").replace(/^([A-Za-z]:)/, "/$1");
        const folder = vscode.Uri.from({
          scheme: "vscode-remote",
          authority: new URL(endpoint("/")).host,
          path: remotePath,
        });
        await vscode.commands.executeCommand("vscode.openFolder", folder, false);
      }
    },
    devices: async () => {
      if (!(await hostOnly())) return;
      const data = await request("/api/devices");
      if (!data) return;
      const choice = await vscode.window.showQuickPick(
        data.devices.map((device) => ({
          label: device.name,
          description: device.platform,
          detail: "Last seen: " + (device.lastSeenAt || "never"),
          device,
        })),
        { title: "Paired Devices — select a device to revoke", placeHolder: data.devices.length ? "" : "No paired devices" },
      );
      if (choice && (await confirm("Revoke " + choice.device.name + "?")))
        await request("/api/devices/" + encodeURIComponent(choice.device.id), "DELETE");
    },
    extensions: async () => {
      if (!(await hostOnly())) return;
      const extensions = await request("/api/extensions");
      if (!extensions) return;
      const choice = await vscode.window.showQuickPick(
        [
          { label: "$(add) Install Extension", install: true },
          ...extensions.map((extension) => ({
            label: extension.id,
            description: extension.version,
            extension,
          })),
        ],
        { title: "IDE Extensions — select one to uninstall" },
      );
      if (!choice) return;
      if (choice.install) {
        const id = await vscode.window.showInputBox({ prompt: "Extension ID or VSIX path" });
        if (id) await request("/api/extensions/install", "POST", { id });
      } else if (await confirm("Uninstall " + choice.extension.id + "?"))
        await request("/api/extensions/uninstall", "POST", { id: choice.extension.id });
    },
    logs: async () => {
      if (!(await hostOnly())) return;
      const entries = await request("/api/logs");
      if (!entries) return;
      const output = vscode.window.createOutputChannel("Vistta Code Hub");
      output.clear();
      for (const entry of entries) output.appendLine(`${entry.ts} [${entry.level}] [${entry.source}] ${entry.message}`);
      output.show();
      context.subscriptions.push(output);
    },
    configure: openSettings,
    computers: async () => {
      if (!(await hostOnly())) return;
      const data = await request("/api/remotes");
      if (!data) return;
      const statuses = await Promise.all(data.remotes.map((remote) => request(remotePath(remote, "/status"))));
      const choice = await vscode.window.showQuickPick(
        [
          { label: "$(add) Add Computer…", add: true },
          ...data.remotes.map((remote, index) => ({
            label: "$(remote) " + remote.name,
            description: remote.url,
            detail: remoteDetail(statuses[index]),
            remote,
            ready: !!statuses[index]?.online && !!statuses[index]?.paired,
          })),
        ],
        {
          title: "Other Computers",
          placeHolder: data.remotes.length ? "Open the IDE of another computer" : "No other computers yet",
        },
      );
      if (!choice) return;
      if (choice.add) return commands.addComputer();
      const next = await vscode.window.showQuickPick(
        [
          ...(choice.ready ? [{ label: "$(link-external) Open IDE", open: true }] : []),
          { label: "$(trash) Forget", forget: true },
        ],
        { title: choice.remote.name },
      );
      if (next?.open) await openRemote(choice.remote);
      if (next?.forget && (await confirm("Forget " + choice.remote.name + "? It will unpair this computer.")))
        await request(remotePath(choice.remote), "DELETE");
    },
    addComputer: async () => {
      if (!(await hostOnly())) return;
      const address = await vscode.window.showInputBox({
        title: "Add Computer (1/2)",
        ignoreFocusOut: true,
        placeHolder: "192.168.1.20:8181",
        prompt: "Address of the other computer. There, turn on Share on LAN and choose Pair a Device.",
      });
      if (!address) return;
      const code = await vscode.window.showInputBox({
        title: "Add Computer (2/2)",
        ignoreFocusOut: true,
        placeHolder: "000000",
        prompt: "Pairing code shown on the other computer",
        validateInput: (value) => (/^\d{6}$/.test(value.trim()) ? undefined : "Enter the 6-digit code"),
      });
      if (!code) return;
      const remote = await request("/api/remotes/pair", "POST", { address: address.trim(), code: code.trim() });
      if (!remote) return;
      const choice = await vscode.window.showInformationMessage(
        "Paired with " + remote.name + ".",
        {
          modal: true,
          detail: remote.fingerprint
            ? "Check that this certificate matches the one shown on that computer:\n" + remote.fingerprint
            : undefined,
        },
        "Open IDE",
      );
      if (choice === "Open IDE") await openRemote(remote);
    },
    openInBrowser: action("openInBrowser"),
    restartIde: async () => {
      if ((await hostOnly()) && (await confirm("Restart the IDE? All connected sessions will disconnect.")))
        await request("/api/ide/restart", "POST");
    },
    menu: async () => {
      if (!(await hostOnly())) return;
      const choice = await vscode.window.showQuickPick(
        [
          { label: "$(broadcast) Share on LAN", description: state.sharing ? "On" : "Off", command: "toggleSharing" },
          { label: "$(device-mobile) Pair a Device", command: "pairDevice" },
          { label: "$(remote-explorer) Other Computers", command: "computers" },
          { label: "$(folder) Projects", command: "projects" },
          { label: "$(device-mobile) Paired Devices", command: "devices" },
          { label: "$(extensions) IDE Extensions", command: "extensions" },
          { label: "$(settings-gear) Settings", command: "openSettings" },
          { label: "$(output) Logs", command: "logs" },
          { label: "$(link-external) Open in Browser", command: "openInBrowser" },
          { label: "$(debug-restart) Restart IDE", command: "restartIde" },
        ],
        { title: "Vistta Code Hub", placeHolder: "Host options" },
      );
      if (choice) await commands[choice.command]();
    },
  };
  context.subscriptions.push(
    item,
    ...Object.entries(commands).map(([name, handler]) => vscode.commands.registerCommand("codeHub." + name, handler)),
  );
  let updates = Promise.resolve();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (changing || !vscode.window.state.focused) return;
      const fields = hostSettings
        .filter(({ setting }) => event.affectsConfiguration("codeHub." + setting))
        .map((field) => ({ ...field, value: settings().get(field.setting) }));
      const sharing = event.affectsConfiguration("codeHub.shareOnLan") ? !!settings().get("shareOnLan") : undefined;
      const startup = event.affectsConfiguration("codeHub.startAtLogin") ? !!settings().get("startAtLogin") : undefined;
      if (!fields.length && sharing === undefined && startup === undefined) return;
      updates = updates
        .then(async () => {
          changing++;
          try {
            if (!(await hostOnly())) return;
            if (fields.length) {
              const config = await request("/api/config");
              if (!config) return;
              const patch = {};
              for (const { section, key, value } of fields) {
                if (section) patch[section] = { ...(patch[section] ?? config[section]), [key]: value };
                else patch[key] = value;
              }
              if ((await request("/api/config", "PATCH", patch)) && fields.some(({ setting }) => setting === "serverPort"))
                void vscode.window.showInformationMessage("Restart the host to apply the HTTP / HTTPS port.");
            }
            if (sharing !== undefined && sharing !== state.sharing)
              await request("/_vch/host/" + (sharing ? "share" : "stopSharing"), "POST");
            if (startup !== undefined) {
              await request("/_vch/startup", "POST", { enabled: startup });
              if (!state.desktop) await settings().update("startAtLogin", undefined, vscode.ConfigurationTarget.Global);
            }
          } finally {
            changing--;
            if (await refresh()) await syncSettings();
          }
        })
        .catch(notify);
      return updates;
    }),
    vscode.window.onDidChangeWindowState(({ focused }) => {
      if (focused) void refresh().then(syncSettings).catch(notify);
    }),
  );
  let ticks = 0;
  const timer = setInterval(() => {
    void refresh()
      .then(() => {
        if (++ticks % 5 === 0) return syncSettings();
      })
      .catch(notify);
  }, 1000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  void refresh().then(syncSettings).catch(notify);
};

exports.deactivate = () => undefined;

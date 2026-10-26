/** VISTTA Code Hub web extension, loaded into every IDE client through the workbench patch. */

const command = (name, title, icon) => ({
  command: `codeHub.${name}`,
  title,
  category: "VISTTA Code Hub",
  ...(icon ? { icon } : {}),
});

export const extensionManifest = {
  name: "code-hub",
  displayName: "VISTTA Code Hub",
  publisher: "vistta",
  version: "0.1.0",
  engines: { vscode: "^1.90.0" },
  browser: "./extension.js",
  activationEvents: ["onStartupFinished"],
  contributes: {
    configuration: {
      title: "VISTTA Code Hub",
      properties: {
        "codeHub.shareOnLan": {
          type: "boolean",
          default: false,
          scope: "application",
          order: 1,
          markdownDescription:
            "Share this workspace with paired devices on the local network. Turning it on asks for a confirmation in the host app. [Pair a device](command:codeHub.pairDevice)",
        },
      },
    },
    commands: [
      command("menu", "Show Options", "$(settings-gear)"),
      command("openSettings", "Open Settings", "$(settings-gear)"),
      command("toggleSharing", "Share on LAN (Toggle)", "$(broadcast)"),
      command("pairDevice", "Pair a Device…", "$(device-mobile)"),
      command("openDashboard", "Open Host Dashboard", "$(dashboard)"),
      command("openInBrowser", "Open in Browser", "$(link-external)"),
      command("restartIde", "Restart IDE", "$(debug-restart)"),
    ],
  },
};

export const extensionScript = String.raw`
const vscode = require("vscode");
exports.activate = (context) => {
  const endpoint = (path) => context.extensionUri.with({ path, query: "", fragment: "" }).toString(true);
  const settings = () => vscode.workspace.getConfiguration("codeHub");
  const item = vscode.window.createStatusBarItem("codeHub.sharing", vscode.StatusBarAlignment.Left, 1000);
  item.name = "VISTTA Code Hub";
  item.command = "codeHub.menu";
  let state = { sharing: false, controllable: false, hostApp: false, lanUrls: [] };
  let known = false;
  let changing = 0;
  const render = () => {
    item.text = state.sharing ? "$(broadcast) LAN" : "$(lock) Local only";
    item.tooltip = state.controllable
      ? (state.sharing ? "Sharing with paired devices on the LAN. " : "") + "VISTTA Code Hub options"
      : state.sharing
        ? "This workspace is shared on the LAN. Options are managed on the host."
        : "This workspace is not shared on the LAN.";
    // Status bar items only accept warning/error backgrounds, so green is the text colour.
    item.color = state.sharing ? new vscode.ThemeColor("testing.iconPassed") : undefined;
    item.show();
  };
  // The setting mirrors the host; the host's real state always wins.
  const mirror = async () => {
    if (!state.controllable || changing) return;
    if (!!settings().get("shareOnLan") !== state.sharing)
      await settings().update("shareOnLan", state.sharing || undefined, vscode.ConfigurationTarget.Global).then(undefined, () => undefined);
  };
  const showShared = () => {
    const url = state.lanUrls && state.lanUrls[0];
    if (!url) return;
    void vscode.window.showInformationMessage("Sharing on LAN: " + url, "Copy Address", "Pair a Device").then((choice) => {
      if (choice === "Copy Address") void vscode.env.clipboard.writeText(url);
      if (choice === "Pair a Device") void commands.pairDevice();
    });
  };
  const refresh = async () => {
    const before = state.sharing;
    try {
      const response = await fetch(endpoint("/_vch/state"), { cache: "no-store" });
      if (response.ok) state = await response.json();
    } catch {}
    render();
    if (known && state.controllable && state.sharing && !before) showShared();
    known = true;
    await mirror();
  };
  const hostOnly = async () => {
    await refresh();
    if (state.controllable) return true;
    void vscode.window.showInformationMessage(
      (state.sharing ? "This workspace is shared on the LAN. " : "") + "VISTTA Code Hub options can only be changed on the host.",
    );
    return false;
  };
  const run = async (action) => {
    const response = await fetch(endpoint("/_vch/host/" + action), { method: "POST", headers: { "x-vch-request": "1" } }).catch(() => undefined);
    if (!response || !response.ok) {
      const message = response ? await response.text().catch(() => "") : "";
      void vscode.window.showErrorMessage(message || "VISTTA Code Hub: the host did not respond.");
      return false;
    }
    return true;
  };
  const apply = async (task) => {
    changing++;
    try {
      await task();
    } finally {
      changing--;
      setTimeout(refresh, 1500);
    }
  };
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      // Only the focused host window acts, so other clients don't repeat the change.
      if (!state.controllable || !vscode.window.state.focused || !event.affectsConfiguration("codeHub.shareOnLan")) return;
      const enabled = !!settings().get("shareOnLan");
      if (enabled !== state.sharing) await apply(() => run(enabled ? "share" : "stopSharing"));
    }),
  );
  const action = (name) => async () => {
    if (await hostOnly()) await run(name);
  };
  const commands = {
    openSettings: () => vscode.commands.executeCommand("workbench.action.openSettings", "@ext:vistta.code-hub"),
    toggleSharing: async () => {
      if (await hostOnly()) await apply(() => run(state.sharing ? "stopSharing" : "share"));
    },
    pairDevice: action("pairDevice"),
    openDashboard: action("openDashboard"),
    openInBrowser: action("openInBrowser"),
    restartIde: action("restartIde"),
    menu: async () => {
      if (!(await hostOnly())) return;
      const check = (on) => (on ? "$(pass-filled) On" : "$(circle-large-outline) Off");
      const items = [
        { label: "$(broadcast) Share on LAN", description: check(state.sharing), command: "toggleSharing" },
        { label: "$(device-mobile) Pair a Device…", description: "Connect a phone, tablet or computer", command: "pairDevice" },
        { label: "", kind: vscode.QuickPickItemKind.Separator },
        { label: "$(dashboard) Open Host Dashboard", command: "openDashboard" },
        { label: "$(link-external) Open in Browser", command: "openInBrowser" },
        { label: "$(debug-restart) Restart IDE", command: "restartIde" },
        { label: "$(settings-gear) Open Settings", command: "openSettings" },
      ];
      const picked = await vscode.window.showQuickPick(items, { title: "VISTTA Code Hub", placeHolder: "Host options" });
      if (picked && picked.command) await commands[picked.command]();
    },
  };
  context.subscriptions.push(item, ...Object.entries(commands).map(([name, handler]) => vscode.commands.registerCommand("codeHub." + name, handler)));
  const timer = setInterval(refresh, 5000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  void refresh();
  // Load every provider's models (e.g. Ollama) so they appear in the Chat model picker.
  void Promise.resolve(vscode.lm && vscode.lm.selectChatModels({})).catch(() => undefined);
};
exports.deactivate = () => undefined;
`;

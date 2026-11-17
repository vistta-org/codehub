// Desktop title bar for the IDE windows of the Vistta Code Hub app (served at
// /_vch/titlebar.js and added to the workbench page by the hub proxy). The
// windows are frameless, so this adds minimize/maximize/close to VS Code's own
// title bar. On Windows, WebView2 honours VS Code's `app-region: drag` overlay,
// so Windows itself moves the window; the mousedown handler below covers
// webviews that ignore app-region. Outside the desktop app (plain browsers,
// PWAs) there is no Tauri bridge and it does nothing.
(() => {
  const tauri = /** @type {any} */ (window).__TAURI_INTERNALS__;
  const label = tauri?.metadata?.currentWindow?.label;
  if (!label || window.top !== window || typeof tauri.invoke !== "function") return;
  const call = (command) => tauri.invoke("plugin:window|" + command, { label });

  const style = document.createElement("style");
  style.textContent = `
    /* Same as VS Code's own title-bar toolbars: above the drag overlay, and no-drag
       because WebView2 honours app-region (otherwise Windows swallows the clicks). */
    .vch-window-controls {
      display: flex; flex-shrink: 0; height: 100%; margin-left: 6px;
      position: relative; z-index: 2500; -webkit-app-region: no-drag; app-region: no-drag;
    }
    .vch-window-controls > .vch-window-control.codicon {
      display: flex; align-items: center; justify-content: center;
      width: 46px; height: 100%; font-size: 16px; color: inherit; cursor: default;
    }
    .vch-window-controls > .vch-window-control:hover { background-color: rgba(128, 128, 128, 0.22); }
    .vch-window-controls > .vch-window-control.vch-close:hover { background-color: #e81123; color: #ffffff; }
  `;
  document.head.append(style);

  let maximize;
  const sync = async () => {
    if (!maximize) return;
    const maximized = await call("is_maximized").catch(() => false);
    maximize.classList.toggle("codicon-chrome-restore", maximized);
    maximize.classList.toggle("codicon-chrome-maximize", !maximized);
    maximize.title = maximized ? "Restore" : "Maximize";
  };

  const control = (command, icon, title) => {
    const button = document.createElement("div");
    button.className = `vch-window-control codicon codicon-${icon}` + (command === "close" ? " vch-close" : "");
    button.title = title;
    button.setAttribute("role", "button");
    button.setAttribute("aria-label", title);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void call(command).then(sync, () => undefined);
    });
    return button;
  };

  const attach = () => {
    const right = document.querySelector(".monaco-workbench .part.titlebar .titlebar-right");
    if (!right || right.querySelector(".vch-window-controls")) return;
    const controls = document.createElement("div");
    controls.className = "vch-window-controls";
    maximize = control("toggle_maximize", "chrome-maximize", "Maximize");
    controls.append(control("minimize", "chrome-minimize", "Minimize"), maximize, control("close", "chrome-close", "Close"));
    right.append(controls);
    void sync();
  };

  // The workbench builds (and may rebuild) its title bar after load.
  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      attach();
    });
  }).observe(document.body, { childList: true, subtree: true });
  attach();
  window.addEventListener("resize", () => void sync());

  const interactive =
    "a, button, input, textarea, select, [role=button], [role=menuitem], [role=menubar], [role=tab], [role=search], " +
    ".action-item, .monaco-toolbar, .command-center, .menubar, .vch-window-controls";
  document.addEventListener("mousedown", (event) => {
    const target = event.target;
    if (event.button !== 0 || !(target instanceof Element)) return;
    if (!target.closest(".part.titlebar") || target.closest(interactive)) return;
    if (event.detail === 2) void call("toggle_maximize").then(sync, () => undefined);
    else void call("start_dragging").catch(() => undefined);
  });
})();

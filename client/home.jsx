/**
 * Android client, laid out like VS Code's side bar: the computers this phone
 * paired with as a tree (IDE state, Open IDE, projects, Forget), a welcome
 * view when there are none, notifications and a status bar. Open IDE signs in
 * with a one-time ticket and opens the IDE full screen (trusting only that
 * computer's pinned CA).
 */
import { Component, Form } from "@vistta/js";
import { Button, Icon, Input } from "@vistta/ui";
import { computers, forget, openIde, openProject, pair, projects, status } from "./api.js";
import { parsePairingQr } from "./hosts.js";

const ICON = {
  COMPUTER: "e30a",
  SCAN: "f206",
  ADD: "e145",
  OPEN: "e037",
  FOLDER: "e2c7",
  FORGET: "e16f",
  REFRESH: "e5d5",
  CLOSE: "e5cd",
  COLLAPSED: "e5cc",
  EXPANDED: "e5cf",
  ERROR: "e000",
  INFO: "e88e",
  REMOTE: "eb2f",
  LOADING: "loading",
};

/** VS Code Dark Modern. */
const COLOR = {
  sideBar: "#181818",
  editor: "#1f1f1f",
  border: "#2b2b2b",
  fore: "#cccccc",
  muted: "#9d9d9d",
  hover: "#2a2d2e",
  badge: "#616161",
  accent: "#ad6d32",
  success: "#2ea043",
  warning: "#cca700",
  error: "#f85149",
  info: "#3794ff",
};

/** IDE state → status color. */
const IDE_COLOR = { running: COLOR.success, starting: COLOR.warning, stopping: COLOR.warning };

const flat = { textShadow: "none!", boxShadow: "none!" };

const root = /** @type {JSX.StyleObject} */ ({
  display: "flex",
  flexDirection: "column",
  width: "100%",
  height: "100dvh",
  overflow: "hidden",
  background: COLOR.sideBar,
  color: COLOR.fore,
});

const titleBar = /** @type {JSX.StyleObject} */ ({
  display: "flex",
  alignItems: "center",
  flex: "none",
  minHeight: "12rem",
  padding: "0 1rem 0 5rem",
});

const titleText = /** @type {JSX.StyleObject} */ ({
  flex: 1,
  fontSize: "3rem",
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
});

const action = /** @type {JSX.StyleObject} */ ({
  variant: "raw",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "11rem",
  height: "11rem",
  p: "0!",
  color: COLOR.fore,
  radius: "1.5rem",
  fontSize: "4.5rem",
  ":active": { background: COLOR.hover },
  ...flat,
});

const paneHeader = /** @type {JSX.StyleObject} */ ({
  display: "flex",
  alignItems: "center",
  gap: "1rem",
  flex: "none",
  minHeight: "9rem",
  padding: "0 4rem 0 1rem",
  borderTop: `1px solid ${COLOR.border}`,
  fontSize: "2.75rem",
  fontWeight: 700,
  textTransform: "uppercase",
});

const countBadge = /** @type {JSX.StyleObject} */ ({
  minWidth: "4.5rem",
  padding: "0.5rem 1.5rem",
  radius: "4rem",
  background: COLOR.badge,
  color: "#ffffff",
  fontSize: "2.75rem",
  fontWeight: 400,
  textAlign: "center",
});

const tree = /** @type {JSX.StyleObject} */ ({ flex: 1, overflowY: "auto", paddingBottom: "4rem" });

const welcome = /** @type {JSX.StyleObject} */ ({
  display: "flex",
  flexDirection: "column",
  gap: "3rem",
  padding: "2rem 5rem",
  lineHeight: 1.45,
});

const wide = (variant) =>
  /** @type {JSX.StyleObject} */ ({ variant, width: "100%", maxWidth: "90rem", minHeight: "10rem", ...flat });

const paragraph = /** @type {JSX.StyleObject} */ ({ margin: 0 });

const notification = /** @type {JSX.StyleObject} */ ({
  display: "flex",
  alignItems: "flex-start",
  gap: "3rem",
  flex: "none",
  margin: "0 3rem 3rem",
  padding: "3rem 1rem 3rem 4rem",
  background: COLOR.editor,
  border: `1px solid ${COLOR.border}`,
  radius: "1.5rem",
  boxShadow: "0 0 8px 2px #00000099",
  fontSize: "3.25rem",
  lineHeight: 1.45,
});

const statusBar = /** @type {JSX.StyleObject} */ ({
  display: "flex",
  alignItems: "stretch",
  flex: "none",
  minHeight: "7rem",
  borderTop: `1px solid ${COLOR.border}`,
  background: COLOR.sideBar,
  fontSize: "3rem",
  paddingBottom: "env(safe-area-inset-bottom)",
});

const statusItem = /** @type {JSX.StyleObject} */ ({
  display: "flex",
  alignItems: "center",
  gap: "1.5rem",
  padding: "0 3rem",
});

const scanView = /** @type {JSX.StyleObject} */ ({
  position: "fixed",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "space-between",
  color: "#ffffff",
  background: "transparent",
});

const scanBanner = /** @type {JSX.StyleObject} */ ({
  alignSelf: "stretch",
  padding: "4rem 5rem",
  background: "#000000b3",
  textAlign: "center",
  lineHeight: 1.45,
});

const scanFrame = /** @type {JSX.StyleObject} */ ({
  width: "min(70vw, 70vh)",
  aspectRatio: "1",
  border: "2px solid #ffffff",
  radius: "3rem",
  boxShadow: "0 0 0 100vmax #00000066",
});

const scanFooter = /** @type {JSX.StyleObject} */ ({
  alignSelf: "stretch",
  display: "flex",
  justifyContent: "center",
  padding: "5rem 5rem calc(env(safe-area-inset-bottom) + 5rem)",
  background: "#000000b3",
});

/** @param {string} message @param {string} title @param {string} okLabel */
async function ask(message, title, okLabel) {
  try {
    const { Dialog } = await import("@vistta/js-native/plugins");
    return await Dialog.ask(message, { title, kind: "warning", okLabel, cancelLabel: "Cancel" });
  } catch {
    return window.confirm(`${title}\n\n${message}`);
  }
}

/** Fingerprint confirmation for manual pairing (no QR to compare against). @param {string} fingerprint */
const confirmFingerprint = (fingerprint) =>
  ask(
    `Check that the computer shows this certificate fingerprint (Pair a Device):\n\n${fingerprint}`,
    "Confirm the computer",
    "They match",
  );

/** The barcode scanner shows the camera behind the WebView, so the page must let it through. @param {boolean} on */
function seeThrough(on) {
  for (const element of [document.documentElement, document.body]) element.style.background = on ? "transparent" : "";
}

/** @param {string} origin */
function hostOf(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/**
 * One VS Code tree row, sized for touch.
 * @extends {Component<{ icon: string, label: string, description?: string, badge?: string, tone?: string, depth?: number, chevron?: "open" | "closed", loading?: boolean, disabled?: boolean, onClick?: () => void }>}
 */
class Row extends Component {
  render() {
    return (
      <button
        type="button"
        disabled={this.disabled || this.loading}
        onClick={() => this.onClick?.()}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "2rem",
          width: "100%",
          minHeight: "11rem",
          padding: `0 4rem 0 ${2 + (this.depth ?? 0) * 5}rem`,
          background: "none",
          color: COLOR.fore,
          radius: "0",
          textAlign: "left",
          fontSize: "3.5rem",
          ":active": { background: COLOR.hover },
          ":disabled": { filter: "none", opacity: 0.5 },
          ...flat,
        }}
      >
        <span style={{ display: "inline-flex", width: "5rem", flex: "none", color: COLOR.fore }}>
          {this.chevron && <Icon code={this.chevron === "open" ? ICON.EXPANDED : ICON.COLLAPSED} />}
        </span>
        <span style={{ display: "inline-flex", flex: "none", color: this.tone ?? COLOR.fore }}>
          <Icon code={this.loading ? ICON.LOADING : this.icon} />
        </span>
        <span style={{ flex: "none", maxWidth: "60%", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {this.label}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            color: COLOR.muted,
            fontSize: "3.25rem",
          }}
        >
          {this.description ?? ""}
        </span>
        {this.badge && (
          <span
            style={{
              flex: "none",
              display: "inline-flex",
              alignItems: "center",
              gap: "1.5rem",
              fontSize: "3rem",
              color: COLOR.muted,
            }}
          >
            <span style={{ width: "2rem", height: "2rem", radius: "50%", background: this.tone ?? COLOR.muted }} />
            {this.badge}
          </span>
        )}
      </button>
    );
  }
}

/**
 * A paired computer and its children: Open IDE, Projects (lazy), Forget.
 * @extends {Component<{ computer: import("./api.js").Computer, status?: { online: boolean, paired: boolean, ide?: string, error?: string }, busy: string, run: (key: string, task: () => Promise<unknown>) => Promise<void>, onForget: () => void }>}
 */
class ComputerNode extends Component {
  expanded = true;
  projectsOpen = false;
  /** @type {{ name: string, path: string }[] | undefined} */
  projectList = undefined;

  get ready() {
    return !!this.status?.online && !!this.status.paired;
  }

  get badge() {
    if (!this.status) return "checking";
    if (!this.status.paired) return "unpaired";
    if (!this.status.online) return "offline";
    return this.status.ide ?? "unknown";
  }

  get tone() {
    if (!this.status) return COLOR.muted;
    if (!this.ready) return COLOR.error;
    return IDE_COLOR[this.status.ide ?? ""] ?? COLOR.muted;
  }

  toggleProjects() {
    this.projectsOpen = !this.projectsOpen;
    if (!this.projectsOpen) return;
    const computer = this.computer;
    return this.run(`projects:${computer.id}`, async () => {
      this.projectList = await projects(computer);
    });
  }

  render() {
    return (
      <div>
        <Row
          chevron={this.expanded ? "open" : "closed"}
          icon={ICON.COMPUTER}
          label={this.computer.name}
          description={hostOf(this.computer.origin)}
          badge={this.badge}
          tone={this.tone}
          onClick={() => (this.expanded = !this.expanded)}
        />
        {this.expanded && this.status && !this.ready && (
          <p
            style={{ margin: 0, padding: "1rem 4rem 2rem 14rem", color: COLOR.muted, fontSize: "3.25rem", lineHeight: 1.45 }}
          >
            {this.status.error}
          </p>
        )}
        {this.expanded && (
          <Row
            depth={1}
            icon={ICON.OPEN}
            label="Open IDE"
            tone={this.ready ? COLOR.success : undefined}
            disabled={!this.ready}
            loading={this.busy === `open:${this.computer.id}`}
            onClick={() => this.run(`open:${this.computer.id}`, () => openIde(this.computer))}
          />
        )}
        {this.expanded && (
          <Row
            depth={1}
            chevron={this.projectsOpen ? "open" : "closed"}
            icon={ICON.FOLDER}
            label="Projects"
            disabled={!this.ready}
            loading={this.busy === `projects:${this.computer.id}`}
            onClick={() => this.toggleProjects()}
          />
        )}
        {this.expanded && this.projectsOpen && this.projectList?.length === 0 && (
          <p style={{ margin: 0, padding: "2rem 4rem 2rem 19rem", color: COLOR.muted, fontSize: "3.25rem" }}>
            No projects in the projects folder yet.
          </p>
        )}
        {this.expanded &&
          this.projectsOpen &&
          this.projectList?.map((project) => (
            <Row
              key={project.path}
              depth={2}
              icon={ICON.FOLDER}
              label={project.name}
              loading={this.busy === `project:${project.path}`}
              onClick={() => this.run(`project:${project.path}`, () => openProject(this.computer, project))}
            />
          ))}
        {this.expanded && <Row depth={1} icon={ICON.FORGET} label="Forget" onClick={() => this.onForget()} />}
      </div>
    );
  }
}

export default class Home extends Component {
  state = computers();
  /** @type {Record<string, { online: boolean, paired: boolean, ide?: string, error?: string }>} */
  statuses = {};
  busy = "";
  error = "";
  detail = "";
  notice = "";
  adding = false;
  scanning = false;
  scanCancelled = false;

  async onConnect() {
    if (window.platform === "server") return;
    await this.refresh();
  }

  get activity() {
    if (this.busy === "scan") return "Waiting for a QR code…";
    if (this.busy === "pair") return "Pairing…";
    if (this.busy === "refresh") return "Checking computers…";
    if (this.busy.startsWith("open:") || this.busy.startsWith("project:")) return "Opening IDE…";
    if (this.busy.startsWith("projects:")) return "Loading projects…";
    if (this.busy.startsWith("forget:")) return "Forgetting…";
    return "";
  }

  async refresh() {
    const list = [...this.state.list];
    const entries = await Promise.all(list.map(async (computer) => [computer.id, await status(computer)]));
    this.statuses = Object.fromEntries(entries);
  }

  /** @param {() => Promise<unknown>} task @param {string} key */
  async run(key, task) {
    this.busy = key;
    this.dismiss();
    try {
      await task();
    } catch (error) {
      this.error = /** @type {Error} */ (error)?.message ?? String(error);
      this.detail = /** @type {any} */ (error)?.detail ?? "";
    } finally {
      this.busy = "";
    }
  }

  dismiss() {
    this.error = "";
    this.detail = "";
    this.notice = "";
  }

  scan() {
    if (this.busy) return;
    return this.run("scan", async () => {
      const { BarcodeScanner } = await import("@vistta/js-native/plugins");
      let permission = await BarcodeScanner.checkPermissions();
      if (permission !== "granted") permission = await BarcodeScanner.requestPermissions();
      if (permission !== "granted")
        throw new Error(
          "Camera access is needed to scan the pairing QR code. Allow it in Android settings, or use Enter Address.",
        );
      this.scanCancelled = false;
      this.scanning = true;
      seeThrough(true);
      let scanned;
      try {
        scanned = await BarcodeScanner.scan({ formats: [BarcodeScanner.Format.QRCode], windowed: true });
      } catch (error) {
        if (this.scanCancelled) return;
        throw error;
      } finally {
        this.scanning = false;
        seeThrough(false);
      }
      const { origin, code, fingerprint } = parsePairingQr(scanned.content);
      this.busy = "pair";
      await this.paired(await pair({ address: origin, code, fingerprint }));
    });
  }

  async cancelScan() {
    this.scanCancelled = true;
    const { BarcodeScanner } = await import("@vistta/js-native/plugins");
    await BarcodeScanner.cancel().catch(() => undefined);
  }

  /** @param {{ values?: Record<string, string> }} event */
  pairManually({ values }) {
    if (!values) return;
    return this.run("pair", async () => {
      await this.paired(await pair({ address: values.address, code: values.code, confirm: confirmFingerprint }));
    });
  }

  /** @param {import("./api.js").Computer | null} computer */
  async paired(computer) {
    if (!computer) return;
    this.adding = false;
    await this.refresh();
    this.notice = `Paired with ${computer.name}.`;
  }

  /** @param {import("./api.js").Computer} computer */
  async forget(computer) {
    if (!(await ask(`Forget ${computer.name}? The computer will unpair this phone.`, "Forget computer", "Forget"))) return;
    await this.run(`forget:${computer.id}`, async () => {
      await forget(computer);
      await this.refresh();
    });
  }

  render() {
    return this.scanning ? (
      <div style={scanView}>
        <div style={scanBanner}>Point the camera at the QR code shown in Pair a Device on the computer.</div>
        <div style={scanFrame} />
        <div style={scanFooter}>
          <Button style={wide("secondary")} label="Cancel" onClick={() => this.cancelScan()} />
        </div>
      </div>
    ) : (
      <div style={root}>
        <div style={titleBar}>
          <span style={titleText}>Vistta Code Hub</span>
          <Button name="Scan QR Code" style={action} icon={ICON.SCAN} disabled={!!this.busy} onClick={() => this.scan()} />
          <Button name="Enter Address" style={action} icon={ICON.ADD} onClick={() => (this.adding = true)} />
          <Button
            name="Refresh"
            style={action}
            icon={this.busy === "refresh" ? ICON.LOADING : ICON.REFRESH}
            disabled={!!this.busy}
            onClick={() => this.run("refresh", () => this.refresh())}
          />
        </div>
        <div style={paneHeader}>
          <Icon code={ICON.EXPANDED} />
          <span style={{ flex: 1 }}>Computers</span>
          {this.state.list.length > 0 && <span style={countBadge}>{this.state.list.length}</span>}
        </div>
        <div style={tree}>
          {this.state.list.map((computer) => (
            <ComputerNode
              key={computer.id}
              computer={computer}
              status={this.statuses[computer.id]}
              busy={this.busy}
              run={(key, task) => this.run(key, task)}
              onForget={() => this.forget(computer)}
            />
          ))}
          {this.adding && (
            <Form onSubmit={(event) => this.pairManually(event)} style={welcome}>
              <p style={paragraph}>
                On the computer turn on Share on LAN and choose Pair a Device, then enter its address and the 6-digit code it
                shows.
              </p>
              <Input name="address" label="Address" placeholder="192.168.1.20 or host:8181" required />
              <Input name="code" label="Pairing code" placeholder="000000" required />
              <Button type="submit" style={wide("primary")} label="Pair" loading={this.busy === "pair"} />
              <Button style={wide("secondary")} label="Cancel" onClick={() => (this.adding = false)} />
            </Form>
          )}
          {!this.adding && this.state.list.length === 0 && (
            <div style={welcome}>
              <p style={paragraph}>You have not paired with a computer yet.</p>
              <p style={paragraph}>
                On a computer running Vistta Code Hub, open the Code Hub menu in the status bar, turn on Share on LAN and
                choose Pair a Device.
              </p>
              <Button
                style={wide("primary")}
                label="Scan QR Code"
                loading={this.busy === "scan"}
                onClick={() => this.scan()}
              />
              <Button style={wide("secondary")} label="Enter Address" onClick={() => (this.adding = true)} />
            </div>
          )}
        </div>
        {(this.error || this.notice) && (
          <div style={notification}>
            <span style={{ display: "inline-flex", paddingTop: "0.5rem", color: this.error ? COLOR.error : COLOR.info }}>
              <Icon code={this.error ? ICON.ERROR : ICON.INFO} />
            </span>
            <div style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
              <div>{this.error || this.notice}</div>
              {this.detail && <div style={{ marginTop: "1rem", color: COLOR.muted, fontSize: "3rem" }}>{this.detail}</div>}
            </div>
            <Button name="Close" style={action} icon={ICON.CLOSE} onClick={() => this.dismiss()} />
          </div>
        )}
        <div style={statusBar}>
          <span style={{ ...statusItem, background: COLOR.accent, color: "#ffffff" }}>
            <Icon code={ICON.REMOTE} />
          </span>
          <span style={statusItem}>
            {this.activity && <Icon code={ICON.LOADING} />}
            {this.activity || `${this.state.list.length} ${this.state.list.length === 1 ? "computer" : "computers"}`}
          </span>
        </div>
      </div>
    );
  }
}

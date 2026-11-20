# Chat-only view

Status: **Phase 1 implemented** (Chat in the Android app). Phases 2 and 3 are planned.

## Goal

On a phone, a user often wants only the IDE's Chat: ask a question, start an
agent task, or check a running session. The full IDE is hard to use on a small
screen. The chat-only view opens the IDE's Chat for a paired computer and hides
everything else.

The chat-only view must keep what the IDE's Chat already has:

- the same chat sessions as the desktop IDE and every other client;
- the same models (including BYOK models such as Ollama) and agent tools;
- the same workspace context (open project, files, terminal).

## Current state

- The Android client opens the full IDE in a pinned, full-screen WebView
  (`openIde(computer, target)` in `client/api.js`). It signs in with a one-time
  ticket. `target` is any IDE path, for example `/?folder=…`. **Chat** uses the
  same flow with a chat marker (Phase 1).
- `hub/workbench.js` already stores the Chat session index and session logs in
  server-side storage. Every client sees the same sessions.
- The Code Hub web extension (`hub/extension-client.js`) loads in every client
  and can run workbench commands.
- The chat agent and tools run in the IDE. The hub has no chat API of its own.

## Approach

Reuse the IDE's own Chat. Do not build a second chat engine. A separate engine
would lose agent tools, workspace context and session sharing.

### Phase 1: chat layout in the IDE WebView (implemented)

1. Each computer card in the client has a **Chat** button next to **Open IDE**,
   and each project row has a chat button (`openChat` in `client/api.js`).
2. The client adds `vch=chat` to the IDE target (`chatPath` in
   `client/hosts.js`), for example `/?folder=…&vch=chat`. Without a project,
   code-server opens the last folder and keeps the marker.
3. The workbench patch (`hub/workbench.js`) reads the marker from the page URL.
   A chat window gets window-only `configurationDefaults`
   (`CHAT_LAYOUT_DEFAULTS`): no activity bar, status bar, layout controls or
   startup editor, and `codeHub.chatOnly: true`. The user's own settings still
   win.
4. The Code Hub web extension sees `codeHub.chatOnly` on activation. It closes
   the side bar and the panel, opens the Chat and maximizes the secondary side
   bar.
5. Layout state does not reach other windows. Workbench layout state is in
   shared server storage, and a test showed that a maximized Chat leaked into
   the next normal IDE window. A chat window therefore has
   `remoteStorageEnabled: false`: its UI state stays in the phone's WebView.
   Chat sessions still sync, because the shared session index and the session
   logs are files on the server.
6. `codeHub.chatOnly` is visible in Settings. A hidden setting
   (`included: false`) is not registered, so the extension could not read it.
   If a user turns it on, every IDE window shows only the Chat.

Not done yet: a mobile style for the Chat view (larger touch targets, an input
box that stays above the on-screen keyboard). Check it on a device first.

Result: a phone gets the full Chat with no new hub route and no new security
surface. The pairing, ticket and pinned-CA flow stays the same.

### Phase 2: session list in the app

1. Add `GET /api/chat/sessions` (auth level `device`). It reads the shared
   session index that `hub/workbench.js` writes (`.vch-shared-index`) and
   returns id, title, last message date and workspace.
2. Show a **Chats** node under each computer in the client tree.
3. Tapping a session opens the Phase 1 chat layout with that session
   (for example `&vch=chat&session=<id>`). The extension opens the session by id.
4. Optional: a **New chat** action opens an empty session.

The API is read-only. It does not send messages, so it does not need a model
or an agent on the hub.

### Phase 3 (optional): native composer

A native message list and input box in the app, so that short questions do not
need the WebView.

This phase needs a running workbench to drive the chat agent. Possible design:
the Code Hub extension in an open IDE window relays requests from the hub to the
Chat. When no IDE window is open, the app falls back to Phase 1.
**Unverified:** whether the extension API can submit a message to an existing
Chat session and stream the reply. Do a spike before you commit to this phase.

## Security

- Phase 1 uses the existing ticket and IDE session cookie. No change.
- Phase 2 adds one `device` route. It must return only metadata, never session
  contents, unless the request has a valid device token or IDE session cookie.
- Revoking a device must end chat access in the same way as IDE access.

## Tests

- Client (`tests/client.test.js`): `chatPath` adds the marker to the same IDE
  path and never leaves the computer's origin.
- Workbench (`tests/workbench.test.js`): a `?vch=chat` window gets the chat
  defaults and `remoteStorageEnabled: false`; other windows are unchanged.
- Extension (`tests/extension.test.js`): `codeHub.chatOnly` opens the Chat
  layout; without it the layout is unchanged.
- Planned (Phase 2): `/api/chat/sessions` requires a device token on HTTPS,
  reads the shared index, and handles a missing or invalid index file.

## Open questions

- Chat in the editor area or in a maximized side bar: which works better on a
  phone keyboard? Phase 1 uses the maximized secondary side bar.
- Should the desktop app also get a "Chat only" window?
- Which workspace should a chat start in when the computer has several projects?
  Phase 1 uses the chosen project, or the IDE's last folder.

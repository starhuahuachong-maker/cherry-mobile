# Cherry Mobile

Mobile companion UI for [Cherry Studio](https://github.com/CherryHQ/cherry-studio).

Created by 花花虫.

Cherry Mobile turns a desktop-first Cherry Studio install into something you can actually use from your phone: browse assistants, inspect real conversation history, open live sessions, and continue chatting without remoting into the whole desktop.

It is a self-hosted bridge, not an official Cherry Studio plugin. The core idea is simple:

- keep Cherry Studio as the source of truth on your Mac
- read Cherry's local data directly
- expose a phone-friendly web UI on your local network or tailnet
- send messages back into the real Cherry workflow

## Why This Exists

Cherry Studio has a strong desktop experience, but there is no built-in mobile interface for:

- checking old conversations from your phone
- continuing an existing topic while away from your desk
- quickly looking up what an assistant said earlier
- using your home server or Mac mini as a remote Cherry endpoint

Cherry Mobile fills that gap without trying to replace the desktop app. It adds a thin mobile layer on top of the existing Cherry installation.

## What You Can Do

### 1. Browse Real Cherry History

- list assistants and their topics
- open full message history for a topic
- poll for updates so new replies appear on the phone shortly after they land on desktop
- read exported Markdown history files when present

### 2. Continue a Real Topic From Phone

- select an existing history topic
- type a follow-up message on your phone
- Cherry Mobile sends it back into the same underlying Cherry workflow
- if desktop automation succeeds, the message appears natively inside Cherry Studio

### 3. Use Live Agent Sessions

- list agents exposed by Cherry's local API
- browse recent sessions for an agent
- create a new mobile session
- continue a live session from the phone UI

### 4. Run It Like a Personal Tool, Not a Cloud Service

- works well behind `localhost`, LAN, or Tailscale
- supports session-cookie auth for the web UI
- installable as a PWA for a cleaner phone experience
- optimized for one-user, self-hosted usage

## End-to-End Flow

Typical usage looks like this:

1. Cherry Studio runs on your Mac as usual.
2. Cherry Mobile reads Cherry's IndexedDB and local storage to build a history tree.
3. You open the mobile web app from your phone.
4. You browse an assistant, open a topic, and read messages.
5. When you send a follow-up, Cherry Mobile tries to drive the real Cherry desktop UI through macOS accessibility.
6. If the UI path is unavailable, it can fall back to Cherry's local API path.
7. The phone UI keeps polling and updates as the topic changes.

The important part is that this is not a fake mirror chat. The goal is to stay attached to the real Cherry installation and its real data.

## Architecture

```text
Phone Browser --HTTPS--> Tailscale Serve / Reverse Proxy --> Cherry Mobile Server
                                                              |
                                              +---------------+---------------+
                                              |               |               |
                                              v               v               v
                                      Parse IndexedDB   Drive Desktop UI   Proxy Cherry API
                                      + Local Storage     via AX APIs        (23333)
```

### Main Components

| File | Language | Responsibility |
|------|----------|----------------|
| `server.py` | Python | HTTP server, auth, API proxy, async send pipeline, topic continuation |
| `cherry_history.py` | Python | Parses Cherry Studio's Chromium IndexedDB / LevelDB data |
| `cherry_ui.swift` | Swift | Uses macOS accessibility APIs to control Cherry Studio's UI |
| `extract_persist.js` | Node.js | Reads persisted local storage state from Cherry's LevelDB |
| `static/` | HTML / JS / CSS | Mobile-first SPA, history browser, live session UI, PWA shell |

## How It Works Internally

### History Extraction

Cherry Studio stores important state in Chromium-managed local storage and IndexedDB files. Cherry Mobile reads those files directly instead of relying on an official conversation API.

That means the project has to do low-level work:

- scan `.ldb` and `.log` files
- decode mixed binary structures
- reconstruct assistants, topics, messages, and blocks
- tolerate storage noise and partial records

This is the hardest part of the project, but it is what makes the history browser possible.

### Message Sending Strategy

Cherry Mobile uses two paths when sending:

1. Preferred path: drive the actual Cherry Studio desktop UI with macOS accessibility APIs, so the message is injected into the real visible app.
2. Fallback path: proxy selected Cherry API endpoints and send through the local Cherry API server.

This split matters because the UI-driven path preserves the feeling of "I am still using Cherry itself", while the API fallback keeps the tool usable when UI automation is brittle.

### Sync Model

The frontend is intentionally simple:

- mobile SPA in `static/app.js`
- periodic polling for history refresh
- live session loading through Cherry's local API
- optimistic pending state while a send is in flight

This is not a websocket-heavy architecture. For a personal self-hosted tool, polling is simpler and reliable enough.

## Security Model

Cherry Mobile is designed for trusted personal environments, not for open internet exposure.

### What It Does

- issues a session cookie for the web client
- requires auth for `/api/*`
- supports overriding the session token via environment variable
- keeps the API proxy restricted to specific upstream Cherry paths

### What It Does Not Try To Be

- a multi-user SaaS backend
- a hardened public-facing auth system
- a generic reverse proxy to Cherry Studio

Recommended setup:

- bind Cherry Mobile to `127.0.0.1`
- publish it through Tailscale Serve or another authenticated private tunnel
- do not expose it directly to the public internet

## Requirements

- macOS for desktop automation support
- Cherry Studio installed and running
- Cherry Studio local API available if you want live agent mode / API fallback
- Python 3.11+
- Node.js
- Accessibility permission granted to the process that runs Cherry Mobile

## Quick Start

```bash
npm install
python3 -m venv .venv
source .venv/bin/activate
mkdir -p log data
python3 server.py
```

Then open:

- local browser: `http://127.0.0.1:8765`
- or your private remote URL if you place it behind Tailscale Serve

## Recommended Remote Access With Tailscale

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:8765
```

Then access it from your phone at:

```text
https://<machine>.ts.net:8443
```

This is the cleanest deployment model for the project because it matches the intended trust boundary: personal device to personal machine.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CHERRY_MOBILE_HOST` | `127.0.0.1` | Listen host |
| `CHERRY_MOBILE_PORT` | `8765` | Listen port |
| `CHERRY_BASE_URL` | `http://127.0.0.1:23333` | Cherry Studio local API base URL |
| `CHERRY_MOBILE_SESSION_TOKEN` | random at startup | Fixed session token for browser auth |
| `CHERRY_MOBILE_MAX_BODY_BYTES` | `1048576` | Maximum request body size |
| `CHERRY_API_KEY` | unset | Optional manual override for Cherry API key |

## Project Status

This project is functionally complete for personal use:

- history browsing works
- mobile continuation works
- live agent/session browsing works
- fallback behavior exists when one send path fails
- PWA and fullscreen mobile UX are already in place

It is best described as a focused self-hosted utility, not a generalized framework.

## Limitations

- macOS is required for the desktop automation path
- Cherry storage formats and local APIs may change upstream
- this project assumes a single trusted operator
- there is no official contract from Cherry Studio guaranteeing these internal formats
- remote use is safest through Tailscale or another private tunnel

If Cherry Studio changes its IndexedDB schema, local storage shape, or API behavior, this project may need maintenance.

## Non-Goals

- replacing Cherry Studio's desktop UI
- supporting every OS equally
- exposing all Cherry internal APIs
- becoming a hosted shared service

## Who This Is For

Cherry Mobile is a good fit if you:

- already use Cherry Studio daily
- want to read or continue chats from your phone
- are comfortable self-hosting a small local service
- prefer a direct practical tool over a polished productized platform

It is probably not the right fit if you want:

- a public internet deployment
- enterprise auth and permissions
- zero-maintenance compatibility guarantees
- a fully official upstream integration

## License

MIT

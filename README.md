# Cherry Mobile

Mobile web frontend for [Cherry Studio](https://github.com/CherryHQ/cherry-studio) — view conversation history, browse assistants/topics, and continue chatting from your phone.

Cherry Studio is a desktop Electron app with no built-in mobile UI or conversation API. Cherry Mobile bridges that gap by reading its local database directly and exposing a mobile-friendly web interface over your local network.

## Features

- Browse all assistants, topics, and full message history from Cherry Studio
- Send messages from phone — drives the desktop app via macOS accessibility, or falls back to direct API calls
- Real-time sync — polls Cherry Studio's IndexedDB for updates every few seconds
- Mobile-optimized UI with fullscreen conversation mode
- Session cookie authentication
- PWA support (add to home screen)
- Tailscale-friendly — expose over your tailnet for secure remote access

## Architecture

```
Phone Browser --HTTPS--> Tailscale Serve --> Cherry Mobile Server (port 8765)
                                                    |
                                    +---------------+---------------+
                                    v               v               v
                             Read IndexedDB   Drive Desktop UI   Proxy API
                             (cherry_history)  (cherry_ui.swift) (port 23333)
```

| File | Language | Purpose |
|------|----------|---------|
| server.py | Python | HTTP server, API proxy, auth, async messaging |
| cherry_history.py | Python | Binary parser for Cherry Studio's LevelDB/IndexedDB |
| cherry_ui.swift | Swift | macOS accessibility automation to drive Cherry Studio UI |
| extract_persist.js | Node.js | Reads Cherry Studio's Local Storage via leveldown |
| static/ | HTML/JS/CSS | Mobile SPA frontend |

## Requirements

- macOS (for accessibility automation)
- Cherry Studio desktop app installed and running
- Python 3.11+
- Node.js (for extract_persist.js)
- Accessibility permissions granted (System Settings > Privacy > Accessibility)

## Setup

```bash
npm install
python3 -m venv .venv
source .venv/bin/activate
mkdir -p log data
python3 server.py
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| CHERRY_MOBILE_HOST | 127.0.0.1 | Listen address |
| CHERRY_MOBILE_PORT | 8765 | Listen port |
| CHERRY_BASE_URL | http://127.0.0.1:23333 | Cherry Studio API URL |

### Tailscale Exposure

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:8765
```

Then access from your phone at `https://<machine>.ts.net:8443`.

## How It Works

**Reading history**: Cherry Studio stores conversations in Chromium's IndexedDB (LevelDB format). cherry_history.py directly parses the binary .ldb and .log files to extract messages without requiring Cherry Studio's cooperation.

**Sending messages**: The server first drives Cherry Studio's desktop UI via macOS accessibility APIs (cherry_ui.swift) so messages appear natively. Falls back to direct LLM API calls if the desktop UI isn't available.

**Sync**: The phone polls the server every 1.5-2.5 seconds. The server re-reads LevelDB files with signature-based caching to pick up new messages.

## License

MIT

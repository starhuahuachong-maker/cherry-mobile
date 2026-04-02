# Cherry Mobile: UI & Configuration Proposal

This document describes a plan to make Cherry Mobile easier to set up and use — from the first-time onboarding experience to day-to-day configuration, all from the web UI itself.

## Problem Statement

Today, setting up Cherry Mobile requires:

1. Cloning the repo and installing dependencies (npm, Python venv)
2. Knowing to start `server.py` manually or configure a LaunchAgent
3. Setting environment variables for port, API key, session token, etc.
4. Separately installing and configuring Tailscale for remote access
5. Manually opening the right URL on a phone browser

For someone like a new user who just wants to use Cherry Studio from their phone, this is too many moving parts. The conversation in the Cherry Studio community confirms this — people don't know where to start.

## Design Goals

1. **Zero-config first run** — `python3 server.py` should Just Work with sensible defaults and no required env vars (already mostly true).
2. **In-app Settings page** — a web UI panel where users can view and change configuration without touching env vars or restarting the server.
3. **One-command remote access** — a clear Tailscale setup path, with the server able to show its own connection URL and a QR code.
4. **Mobile onboarding** — when a user opens the app for the first time on their phone, they see a short guided setup, not a blank screen.

---

## Part 1: Setup Guide (For the README / Tutorial)

This is the quick-start flow we want to document for users like 蒙遒然:

### Step 1: Install Tailscale on both devices

- **Mac**: `brew install tailscale` or download from [tailscale.com](https://tailscale.com)
- **Phone (iOS/Android)**: Install the Tailscale app from App Store / Google Play
- Sign in with the same account on both devices

### Step 2: Start Cherry Mobile on your Mac

```bash
cd cherry-mobile
npm install
python3 -m venv .venv && source .venv/bin/activate
mkdir -p log data
python3 server.py
```

### Step 3: Expose via Tailscale

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:8765
```

### Step 4: Open on your phone

Open Safari or Chrome on your phone and go to:

```
https://<your-mac-name>.tail*****.ts.net:8443
```

You can find your exact machine name in the Tailscale app. Bookmark it or add to home screen as a PWA.

That's it — four steps.

---

## Part 2: In-App Settings Page

### 2.1 New UI Tab: Settings

Add a third mode button alongside "History" and "Agents":

```
[ History ] [ Agents ] [ Settings ⚙ ]
```

When tapped, the main area shows a settings form instead of conversations.

### 2.2 Settings Sections

#### Connection

| Field | Description | Current source |
|-------|-------------|----------------|
| Cherry Studio API URL | Base URL for Cherry's local API | `CHERRY_BASE_URL` env var |
| Listen Port | Which port Cherry Mobile runs on | `CHERRY_MOBILE_PORT` env var |
| Connection Status | Live health indicator | Already exists as the badge |

These are read-only on the settings page (changing them requires a server restart), but showing them helps users understand what's connected.

#### Authentication

| Field | Description |
|-------|-------------|
| Session Token | Display current token (masked), with a "Copy" button |
| QR Code | A QR code encoding the full access URL with token — scan from phone to instantly connect |

The QR code is the key UX improvement. On desktop, the settings page shows a QR code. The user scans it with their phone camera, and it opens Cherry Mobile with authentication already embedded in the URL query parameter.

#### API Keys (for fallback send)

| Field | Description |
|-------|-------------|
| Anthropic API Key | For direct API fallback when desktop UI automation is unavailable |
| OpenRouter API Key | Alternative provider fallback |

These should be editable in-app and persisted to a local config file (`data/config.json`), so users don't need to set env vars or edit Cherry Studio's settings.

#### Display Preferences

| Field | Description |
|-------|-------------|
| Language | English (default) / 中文 — for users who prefer Chinese UI |
| Theme | Light (current) / Dark / Auto |
| Messages per page | How many messages to load initially (default: all) |

### 2.3 Implementation Plan

**Backend changes (`server.py`):**

1. Add `GET /api/settings` — returns current config (with secrets masked)
2. Add `PATCH /api/settings` — accepts partial config updates, writes to `data/config.json`
3. On startup, load `data/config.json` and merge with env vars (env vars take precedence)
4. Add `GET /api/settings/qr` — returns a PNG QR code of the access URL

**Frontend changes (`static/`):**

1. Add settings mode to `app.js` state machine
2. New `renderSettings()` function
3. Form inputs bound to the settings API
4. QR code rendering (use a small JS library like `qrcode-generator`, or render server-side)

**Config file format (`data/config.json`):**

```json
{
  "cherryBaseUrl": "http://127.0.0.1:23333",
  "anthropicApiKey": "sk-ant-...",
  "openrouterApiKey": "sk-or-...",
  "language": "en",
  "theme": "light"
}
```

---

## Part 3: QR Code Onboarding Flow

This is the simplest path for new mobile users:

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Desktop browser │     │   Phone camera    │     │  Phone browser   │
│  opens :8765     │────>│   scans QR code   │────>│  auto-opens URL  │
│  sees QR code    │     │                   │     │  with auth token │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

The QR code encodes:
```
https://<tailscale-host>:8443/?token=<session-token>
```

When the frontend detects a `?token=` query parameter, it:
1. Sends `POST /api/auth` with the token
2. Receives the session cookie
3. Strips the token from the URL (for security)
4. Proceeds to the normal app

This means the phone user never needs to manually enter a URL or token.

---

## Part 4: First-Run Experience

When `data/config.json` doesn't exist yet (fresh install), the frontend shows a welcome overlay:

```
┌─────────────────────────────────────┐
│                                     │
│   🍒 Welcome to Cherry Mobile      │
│                                     │
│   Your Cherry Studio companion      │
│   for browsing and chatting         │
│   from your phone.                  │
│                                     │
│   Status: ✅ Connected to Cherry    │
│                                     │
│   [ Open Settings ]  [ Browse Now ] │
│                                     │
└─────────────────────────────────────┘
```

If Cherry Studio's API is not reachable, the overlay shows a troubleshooting hint:

```
   Status: ❌ Cannot reach Cherry Studio

   Make sure Cherry Studio is running and
   its local API is enabled (port 23333).
```

---

## Part 5: Tailscale Auto-Detection

To reduce friction further, the server can detect Tailscale:

1. On startup, check if `tailscale status --json` succeeds
2. If yes, extract the machine's Tailscale hostname
3. Check if `tailscale serve` is already configured for this port
4. Expose this info via `GET /api/settings`:

```json
{
  "tailscale": {
    "available": true,
    "hostname": "macbook-pro.tail*****.ts.net",
    "serveConfigured": true,
    "remoteUrl": "https://macbook-pro.tail*****.ts.net:8443"
  }
}
```

The settings page can then show:
- "Tailscale is active — your remote URL is: `https://...`"
- A one-click button: "Set up Tailscale Serve" that runs the command server-side
- The QR code with the correct remote URL

---

## Part 6: Implementation Priority

| Phase | What | Effort |
|-------|------|--------|
| **P0** | Tutorial in README (Tailscale setup guide) | Small — just docs |
| **P1** | QR code on desktop landing page | Small — one endpoint + JS |
| **P1** | `data/config.json` for persistent settings | Small — backend plumbing |
| **P2** | Settings tab in the web UI | Medium — new UI panel |
| **P2** | Token-in-URL auto-auth flow | Small — frontend + one endpoint |
| **P3** | First-run welcome overlay | Small — frontend only |
| **P3** | Tailscale auto-detection | Medium — subprocess + UI |
| **P4** | Language toggle (EN/ZH) | Medium — i18n extraction |
| **P4** | Dark theme | Small — CSS variables |

### Recommended order

1. Write the setup tutorial and push it (gets users unblocked now)
2. Add QR code + config file (biggest UX win for least effort)
3. Build the settings tab (makes the app self-contained)
4. Polish with first-run overlay and Tailscale detection

---

## Summary

The core insight is: **Cherry Mobile should be configurable from Cherry Mobile itself.** Users shouldn't need to SSH into their Mac or edit environment variables. The web UI should be the single surface for setup, configuration, and usage.

The QR code flow is the highest-leverage change — it turns a multi-step "install Tailscale, find your hostname, type the URL, enter a token" process into "scan this code."

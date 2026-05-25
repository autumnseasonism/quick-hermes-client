# Quick Hermes Client

Quick Hermes Client is a lightweight macOS floating chat client for [Hermes Agent](https://github.com/NousResearch/hermes-agent). It provides a small always-available desktop entry point for talking to a locally running Hermes Agent without opening a terminal.

This project was developed end-to-end by OpenAI Codex in collaboration with the user, including the Electron app structure, Hermes API integration, interaction design, visual polish, packaging setup, and project documentation.

## Features

- Floating desktop icon that expands into a compact chat window.
- Automatic collapse when the app loses focus.
- Visual working indicators while Hermes is running, including an animated ring on the floating icon.
- Local conversation history with recent sessions shown below the input.
- Automatic new session after a configurable idle interval.
- Folder drag-and-drop to start a workspace-scoped conversation.
- File drag-and-drop to inject attachment paths into the next message.
- Clipboard image paste support, saved to a local path and injected into the next message.
- macOS launch-at-login setting.
- macOS packaging through `electron-builder`.

## Requirements

- macOS
- Node.js 24 or newer recommended
- A running Hermes Agent API server on `http://127.0.0.1:8642`

Hermes Agent exposes this local API through its `api_server` gateway platform. The client uses `/v1/runs` and `/v1/runs/{run_id}/events` so it can distinguish streaming text, tool activity, and final task completion.

## Development

Install dependencies:

```bash
npm install
```

Run in development:

```bash
npm start
```

Run syntax checks:

```bash
npm run check
```

## Packaging

Create an unpacked macOS app:

```bash
npm run pack
```

The app will be generated at:

```text
dist/mac-arm64/Quick Hermes.app
```

Create distributable DMG and ZIP files:

```bash
npm run dist
```

The default build is unsigned. On macOS, first launch may require right-clicking the app and choosing Open, or allowing the app from System Settings.

## Configuration

The app stores its local settings and conversation history in Electron's app data directory. In the settings panel you can configure:

- Hermes API base URL
- API key, only needed if your Hermes API server uses `API_SERVER_KEY`
- Idle minutes before a new session is created
- Launch at login

## License

MIT

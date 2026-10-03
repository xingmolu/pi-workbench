<div align="center">

# Pi Desktop

**A desktop workbench for coding agents**: Pi, Claude Code and Codex in one app.

[Download](https://github.com/xingmolu/pi-workbench/releases) · [Features](#features) · [Getting started](#getting-started) · [Build from source](#build-from-source) · [中文](./README.md)

</div>

![A conversation: work steps, code changes and undo](.github/screenshots/conversation.png)

Pi Desktop is a local desktop app (Electron + React) that gives command-line coding agents a
friendlier home: run several sessions per project, see every step and every changed file, approve
changes before they happen and undo a whole turn with one click.

It embeds the [Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
directly and can switch to the Claude Code or Codex engine. Accounts and keys stay on your computer.

> A community project, not affiliated with the Pi project, Anthropic or OpenAI. It is in early
> testing; feedback is very welcome. The interface is available in English and Chinese.

## Features

**Three engines, chosen per session**
- **Pi**: many model providers. Sign in with a ChatGPT subscription or use an API key
  (OpenRouter, DeepSeek, Kimi, Anthropic, or any OpenAI / Anthropic compatible gateway).
- **Claude Code**: the official Claude Agent SDK, with a Claude subscription or an API key.
- **Codex**: the official Codex CLI, using the ChatGPT account you signed in to in Pi (it asks for
  your permission the first time).
- The Claude Code and Codex programs are not bundled. They are downloaded from their official npm
  packages on first use, checked against pinned digests, and interrupted downloads resume.

**Work you can see and control**
- Each turn's reads, edits and commands fold into a "work" section with details and timings.
- Changes are shown as diffs; a whole turn can be undone, with a warning for files edited since.
- Three permission levels: ask / approve routine actions for me / full access. "Always allow"
  becomes a project rule.
- Parallel sessions in the same project, each with its own run, stop and approvals; subagents with
  their own inspectable transcripts.

![Approve before files change](.github/screenshots/approval.png)

**Workbench**
- Built-in browser (the agent can drive it), terminal, Git (stage, commit, push) and file browser.
- MCP servers (including OAuth sign-in for HTTP servers), skills, and plugins (views, commands,
  agent tools, themes), installed and updated from a folder, a zip or a Git URL.
- Phone companion: pair on the local network with a code, or reach it from anywhere through
  Tailscale; follow progress, approve actions and keep the conversation going.

<p align="center"><img src=".github/screenshots/mobile.png" width="320" alt="Phone companion"></p>

**Everyday comforts**
- English and Chinese interface: follows the system language, or choose one in Settings › General.
- Subscription quota, a model picker with capabilities and recents, session search and archive,
  light and dark themes with accent colours.
- In-app update checks, and a diagnostics report you can export from Settings (keys and tokens are
  removed).

## Getting started

### 1. Download

Get the installer for your platform from [Releases](https://github.com/xingmolu/pi-workbench/releases).
Every green build of `main` is published as a nightly prerelease.

| System | File | First launch |
|---|---|---|
| macOS (Apple silicon / Intel) | `pi-desktop-<version>-arm64.dmg` / `-x64.dmg` | Not notarized yet: move it to Applications, then right-click › Open, or run `xattr -dr com.apple.quarantine "/Applications/Pi Desktop.app"` |
| Windows | `pi-desktop-<version>-setup.exe` | Unsigned: on the SmartScreen prompt choose "More info › Run anyway" |
| Linux | `.AppImage` or `.deb` | `chmod +x` the AppImage first |

Windows and AppImage builds update in place; macOS and deb builds open the download page.

### 2. Open a project and connect a model

Open the app and pick a project folder. Without an account yet, the home page lists the ways to connect:

![Connect a model](.github/screenshots/connect.png)

- **ChatGPT account**: sign in to a Plus / Pro subscription in the browser; Pi and Codex can both use it.
- **API key**: Settings › Engines & accounts › Add API connection, pick the provider and paste the key.
- **Claude account**: switch to the Claude Code engine, let it download, then sign in.

### 3. Work

Describe the task in the composer. `⌘/Ctrl + K` opens the command palette, `⌘/Ctrl + J` toggles
the terminal and `⌘/Ctrl + N` starts a new session.

## Privacy and security

- Accounts, API keys and conversations stay on your machine; Pi Desktop itself collects no usage data
  (the engine programs follow their own published policies).
- When Codex borrows a ChatGPT account it only receives short-lived access tokens; the refresh token
  stays with Pi, and the permission can be revoked at any time.
- Plugins are installed in Settings from a folder, a zip or a Git URL, after showing the permissions
  they request. Plugin pages run in a sandbox; a plugin that runs code does so with your account's
  rights (as editor extensions do), so only install plugins from sources you trust. File writes
  through the plugin API follow the current permission level.
- To write a plugin, use New plugin or Load a plugin under development in the same settings page:
  it loads from your folder and reloads on save, with typed templates, logs and examples in
  `examples/plugins/` (see PLUGINS.md §22).
- Diagnostics stay local; an exported report has keys, tokens and your home directory removed and is
  yours to share or not.

## Build from source

Requires Node.js 22 and Git.

```bash
git clone https://github.com/xingmolu/pi-workbench.git
cd pi-workbench
npm ci
npm run dev        # development mode
npm run demo       # offline demo with a local fake model, no account needed
npm test           # unit tests
npm run test:e2e   # end-to-end tests (Playwright + Electron)
npm run build && npx electron-builder --linux   # package (or --win; on macOS run npm run build:native:mac, then --mac)
```

Architecture, implementation notes and testing: [DEVELOPMENT.md](./DEVELOPMENT.md) (Chinese).
Plugins: [PLUGINS.md](./PLUGINS.md). Engine integration: [docs/architecture](./docs/architecture/agent-runtime-providers.md).

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](./CONTRIBUTING.md). Please report
security problems privately as described in [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE). The Claude Code and Codex programs are not distributed with this project; their own
terms apply when you use them.

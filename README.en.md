<div align="center">

<img src="resources/branding/logo.svg" width="128" alt="Pi Desktop logo" />

# Pi Desktop

**One app, three coding agents**: a desktop GUI for Pi, Claude Code and Codex. Switch engines per session.

[![Release](https://img.shields.io/github/v/release/xingmolu/pi-workbench?include_prereleases&label=download)](https://github.com/xingmolu/pi-workbench/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Stars](https://img.shields.io/github/stars/xingmolu/pi-workbench?style=flat)](https://github.com/xingmolu/pi-workbench/stargazers)
![macOS · Windows · Linux](https://img.shields.io/badge/macOS%20·%20Windows%20·%20Linux-lightgrey)

[Download](https://github.com/xingmolu/pi-workbench/releases) · [Features](#features) · [Getting started](#getting-started) · [Build from source](#build-from-source) · [中文](./README.md)

</div>

![A conversation: work steps, code changes and undo](.github/screenshots/conversation.png)

## Why Pi Desktop

- **No more juggling three terminals**: in one project, run Pi on DeepSeek in one session, Claude
  Code in another and Codex in a third, each on its own.
- **One ChatGPT subscription, two engines**: sign in once in Pi and Codex borrows the account.
- **One gateway, all three engines**: enter its address and key once; the app detects which
  OpenAI / Anthropic protocols it speaks, ticks the engines that can use it and fetches its models.
- **See it, approve it, undo it**: every read, edit and command is laid out; approve file changes
  before they happen and undo a whole turn with one click.
- **Local and private**: accounts and keys stay on your computer. Open source, MIT licensed.

Pi Desktop is a local desktop app (Electron + React). It embeds the
[Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) directly; the
Claude Code and Codex programs are downloaded from their official npm packages on first use.

> A community project, not affiliated with the Pi project, Anthropic or OpenAI. It is in early
> testing and feedback is very welcome. If you find it useful, a ⭐ helps others find it. The
> interface is available in English and Chinese.

## Features

**Three engines, chosen per session**
- **Pi**: many model providers. Sign in with a ChatGPT subscription or use an API key
  (OpenRouter, DeepSeek, Kimi, Anthropic, or any OpenAI / Anthropic compatible gateway).
- **Claude Code**: the official Claude Agent SDK, with a Claude subscription or any
  Anthropic-compatible API or gateway (`x-api-key` or Bearer authentication).
- **Codex**: the official Codex CLI, with the ChatGPT account you signed in to in Pi (it asks for
  your permission the first time) or any gateway that offers the OpenAI Responses API.
- The Claude Code and Codex programs are not bundled. They are downloaded from their official npm
  packages on first use, checked against pinned digests, and interrupted downloads resume.

**Models and gateways**

Settings › Engines & accounts lists subscription accounts by email, and API keys and gateways one
service per row, tagged with the engines that use it.

![Engines & accounts: three engines, subscriptions and one gateway shared by all three](.github/screenshots/engines.png)

Adding a gateway takes its address and key once. "Test and fetch models" checks which protocols it
speaks (no tokens are spent) and ticks the engines that can use it:

| Engine | Protocol it uses |
|---|---|
| Pi | Any of OpenAI Chat Completions, OpenAI Responses, Anthropic Messages |
| Claude Code | Anthropic Messages (at the gateway root or `/anthropic`; `x-api-key` or Bearer is detected) |
| Codex | OpenAI Responses |

<table>
<tr>
<td width="50%"><img src=".github/screenshots/gateway.png" alt="Adding a gateway: the detected protocols and the engines that can use it"></td>
<td width="50%"><img src=".github/screenshots/models.png" alt="Switching account and model from the composer"></td>
</tr>
<tr>
<td align="center">Detect the protocols, choose the engines</td>
<td align="center">Switch account and model from the composer</td>
</tr>
</table>

The screenshots show the Chinese interface; the app follows your system language.

**Work you can see and control**
- Each turn's reads, edits and commands fold into a "work" section with details and timings.
- Changes are shown as diffs; a whole turn can be undone, with a warning for files edited since.
- Three permission levels: ask / approve routine actions for me / full access. "Always allow"
  becomes a project rule.
- Parallel sessions in the same project, each with its own run, stop and approvals; subagents with
  their own inspectable transcripts.

![Approve before files change](.github/screenshots/approval.png)

**Workbench**
- Four columns: activity rail, projects and sessions, conversation, workbench; back / forward in the
  title bar, and the workbench can be maximized.
- Workbench tools: files, change review, Git (stage, commit, push, and a commit message written
  from the diff), terminal and a browser whose pages are tabs (the agent can drive it);
  `⌘/Ctrl + 1…9` switches tabs, and an empty workbench lists the tools and recently visited sites.
- Code review: uncommitted changes, unpushed commits and GitHub pull requests in one place to read
  diffs, merge and comment; hand a review to Pi, or ask about a pull request directly.

![Code review: a pull request's summary, checks and question box](.github/screenshots/code-review.png)

- MCP servers (including OAuth sign-in for HTTP servers), skills, and plugins (views, commands,
  agent tools, themes), installed and updated from a folder, a zip or a Git URL.
- Phone companion: pair on the local network with a code, or reach it from anywhere through
  Tailscale; follow progress, approve actions and keep the conversation going.

<p align="center"><img src=".github/screenshots/mobile.png" width="320" alt="Phone companion"></p>

**Everyday comforts**
- English and Chinese interface: follows the system language, or choose one in Settings › General.
- Subscription quota, a model picker with capabilities and recents, session search and archive,
  light and dark themes with accent colours.
- New conversations are titled after their first turn; titles and commit messages come from a
  small, fast model, which you can choose or switch off in Settings › General.
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

- **ChatGPT account**: sign in to a Plus / Pro subscription in the browser; Pi and Codex can both use it.
- **API key / gateway**: in Settings › Engines & accounts › Add endpoint, pick a provider or Custom,
  enter the address and key, then "Test and fetch models" (see [Models and gateways](#features)).
- **Claude account**: switch to the Claude Code engine, let it download, then sign in.

### 3. Work

Describe the task in the composer. Handy shortcuts:

| Shortcut | Does |
|---|---|
| `⌘/Ctrl + K` | Command palette (search sessions, run commands) |
| `⌘/Ctrl + N` | New session |
| `⌘/Ctrl + P` | Search project files |
| `⌘/Ctrl + J` | Open the terminal |
| `⌘/Ctrl + 1…9` | Switch workbench tabs |
| `⌘/Ctrl + [` / `]` | Back / forward |
| `⌘/Ctrl + \` | Show / hide the workbench |

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
# regenerate the README screenshots: see the top of tests/e2e/readme-screenshots.spec.ts
```

Architecture, implementation notes and testing: [DEVELOPMENT.md](./DEVELOPMENT.md) (Chinese).
Plugins: [PLUGINS.md](./PLUGINS.md). Engine integration: [docs/architecture](./docs/architecture/agent-runtime-providers.md).

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](./CONTRIBUTING.md). Please report
security problems privately as described in [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE). The Claude Code and Codex programs are not distributed with this project; their own
terms apply when you use them.

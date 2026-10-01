# Agent Runtime Providers and Host Computer Use

## Goal

Pi Desktop must not bind browser, computer-use, approvals, workbench state, or session
ownership to one agent implementation.

Pi and the official Claude Agent SDK are bundled runtime plugins. Future runtimes can
reuse the same host-owned capabilities without reimplementing OS automation.

## Boundary

```text
Renderer / Mobile
       |
Desktop Session Orchestrator
       |
AgentRuntimeProviderRegistry
       |
       +-- PiRuntimeAdapter
       +-- ClaudeCodeRuntimeAdapter
       +-- FutureRuntimePlugin
       |
Host capability protocol
       |
       +-- BrowserManager
       +-- ComputerUseService
       +-- Approval policy
       +-- Workbench
       +-- Files / terminal / MCP bridges
```

Model provider identity and agent runtime identity are intentionally separate. A Claude
model can run through Pi; selecting Claude Code means selecting a different runtime,
not changing the model selector.

## Runtime contract

Every runtime plugin implements `AgentRuntimePlugin.createSession()` and projects its native protocol onto the
existing desktop contracts:

- `HostCommand` for commands sent into the runtime.
- `HostEvent` for canonical session state.
- Runtime capability requests for host-owned operations.
- `AgentRuntimeSession.dispose()` for deterministic shutdown.

Runtime-specific concepts stay inside the adapter. Main, renderer, mobile, BrowserManager,
and ComputerUseService must not import Pi SDK, Claude Code SDK/CLI, or Codex SDK/CLI types.

## Computer Use ownership

Computer Use is a host capability, not a Pi tool implementation.

The runtime adapter may expose that capability to its agent using the mechanism native to
that runtime:

- Pi: extension tool -> capability request.
- Claude Code: adapter tool / MCP bridge -> capability request.
- Codex: adapter tool / MCP bridge -> capability request.

All routes converge on one host implementation and therefore share:

- permission checks;
- approval policy;
- screen / accessibility ownership;
- stale-state protection;
- cancellation;
- audit / telemetry;
- post-action verification.

## Near-term migration

### Phase 1 — repair existing semantic control

- Accessibility operations no longer require Screen Recording.
- macOS hardened-runtime build includes Apple Events entitlement.
- The Pi `desktop` compatibility adapter was retained during the initial migration
  and retired once the `computer` tool used the shared host capability.

### Phase 2 — host ComputerUseService

Replace the current low-level public contract:

```text
dump / hit_test / click / move / type
```

with host-level operations:

```text
find_roots
observe_ui
search_ui
inspect_ui
act_ui
wait_for
```

Observation returns an immutable `stateId`. Element actions use refs owned by that state.
A stale state must fail and force re-observation.

Observation modes:

- semantic: Accessibility only;
- visual: screenshot / OCR / vision;
- fused: semantic first, visual fallback.

Screen Recording is required only by visual observation.

### Phase 3 — native platform backends

macOS should move from JXA as the primary backend to a signed Swift helper:

- AXUIElement for semantic observation/actions;
- ScreenCaptureKit for visual observation;
- CGEvent only as an input fallback.

The host protocol must stay platform-agnostic so Windows UIA and Linux AT-SPI backends can
be added without changing runtime adapters.

### Phase 4 — selectable runtimes

Add runtime selection to session creation. The selected runtime provider is persisted with
the session independently from the selected LLM/model.

Initial provider IDs:

- `pi`
- `claude-code`
- `codex`

Do not advertise a runtime as selectable until its adapter passes the same capability,
session-lifecycle, cancellation, and approval conformance suite.

## Accounts and credentials

Engines are plugins; accounts are not owned by whichever chat is open.

- **Account providers** — a runtime manifest declares `accountProviders` (`platform`, `label`,
  `login` methods). The plugin owns the mechanics: Pi runs the ChatGPT OAuth flow, Claude Code
  runs the official `claude auth login`. Subscription logins from a third-party OAuth client are
  not used for Claude.
- **Credentials** — `credentials.accounts` and `credentials.apis` declare what a chat on that
  engine can be bound to (`chatgpt`, `claude`; `openai-completions`, `openai-responses`,
  `anthropic-messages`). Settings uses this for the "add account" menu and the "used by" labels.
- **Identity** — an account is shown by email and plan. Pi reads them from the stored ChatGPT
  access token claims; Claude Code reads them from the SDK's `accountInfo()` and remembers them per
  account. Adding an account never asks for a name: Pi generates the alias id, Claude Code a
  configuration-home id. A login whose email is already present is folded into the existing row.
- **Isolation** — each Claude Code subscription account has its own configuration home under
  `<engine config>/accounts/<id>`; the CLI derives its keychain item from that path, so logins
  never overwrite each other. `projects` in every home links to the shared transcripts, so a chat
  can resume under any account. API connections keep their key in the engine's own config file
  and are injected only into that connection's child environment.
- **Configuration route** — Settings reads `runtimeAccounts()` and sends account and endpoint
  commands through `runtimeConfig(runtimeId, command)` to the engine's configuration host. Global
  mutations go through the engine's configuration gate and mark resident chats for refresh, as
  other global settings do. A default engine for new chats is a separate preference
  (`defaultRuntimeId`); without it new chats inherit the current engine.
- **Limits** — Claude Code's selected connection, like its model, is an engine-wide default rather
  than per chat. Sharing one ChatGPT login between Pi and a future Codex engine needs a common
  credential format and is not implemented.

## Adapter implementation choices

### Pi

Keep the existing Pi SDK session as the first adapter. Pi-specific extensions translate
`computer` tool calls into the host `computer-use` capability protocol. The legacy
`desktop` tool and its separate capability protocol have been removed. Historical
tool records still render. The packaged Swift helper and shared capture,
accessibility, input and settings services remain underneath Computer Use.

### Claude Code / Claude Agent SDK

Use the local Claude Agent SDK runtime rather than embedding Computer Use into Claude-specific
code. The SDK supports durable sessions and SDK/local MCP tools, so the adapter should:

1. own Claude session/resume/event translation;
2. expose Pi Desktop host capabilities as SDK custom/MCP tools;
3. translate Claude permission/tool events into Pi Desktop approvals;
4. keep all OS automation in `ComputerUseService`.

This keeps local project filesystem semantics while preserving the same host policy boundary.

### Codex

Use Codex App Server for the runtime adapter when authentication, conversation history,
approvals and streaming agent events are required. The old `codex mcp-server` integration
has been removed and must not be used.

For host capabilities, prefer Codex's supported external MCP connection for the stable path.
App Server `dynamicTools` can map directly to the same capability contract, but it is
currently experimental and should remain behind a provider feature flag until stabilized.

The Codex adapter therefore owns App Server JSON-RPC/session projection while Browser and
Computer Use remain host-owned services.

## Conformance tests

Every runtime adapter should pass one shared suite covering:

1. create/open/dispose resident sessions;
2. canonical snapshot and event projection;
3. browser capability request/cancel;
4. computer-use request/cancel;
5. approval allow/deny;
6. Stop propagation;
7. stale session/generation fencing;
8. runtime crash without host capability leakage.

This is the acceptance boundary for adding Claude Code or Codex.

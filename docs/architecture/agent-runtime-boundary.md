# Agent runtime boundary

Updated 2026-09-30. The runtime is the agent execution engine, separate from the model provider. Pi can use Anthropic or a Codex subscription; that does not turn Pi into the Claude Code runtime.

## Public contract and ownership

- `AgentRuntimePlugin` supplies a manifest and `createSession()`; Pi and official Claude SDK are bundled plugins. Optional capabilities and auth methods are declared by the plugin.
- `AgentRuntimeProviderRegistry` resolves runtime IDs, assigns owned storage, validates public protocol results and projects runtime identity. It contains no SDK message decoding.
- `RuntimeDirectory` manages one lazy configuration host per runtime through the same factory as sessions. It aggregates durable catalogs/search without activating chats, retains saved-path identities, and reports failed requests only while their exact host remains alive.
- `SessionWorkerSupervisor` / `SessionWorkerPool` own durable reference routing, resident lifecycle and foreground selection. Background work is independent of the foreground chat; native active children prevent premature eviction.
- `AgentRuntimeSession` owns command transport and disposal. `UtilityProcessAgentRuntime` is a reusable local transport, not an agent implementation.
- `src/agent-host` and `src/claude-host` own their SDK, credentials, native history and event projection. SDK types cannot enter shared contracts, renderer or desktop orchestration; the architecture check enforces these edges.
- Renderer consumes `AgentSnapshot`, patches, manifests and common tools/subagent DTOs. Child inspections return a distinct `subagent-inspection` result and never replace the parent snapshot.

A new bundled runtime implements its own host and registers its plugin. It need not emulate Pi-specific account aliases, queueing, history editing or checkpoints. The renderer hides unsupported operations. This is an implementation plugin API; there is no external package loader or third-party runtime marketplace.

## Storage and configuration

Every plugin receives `<userData>/runtimes/<id>/{config,sessions,state,cache}`. Production Pi uses its owned config and JSONL session buckets. Claude sets `CLAUDE_CONFIG_DIR` before importing the SDK, strips inherited provider credentials/CLI overrides, and uses SDK-native history behind small desktop reference files. Neither runtime invokes a user's global CLI or silently copies their credentials.

Explicit Pi history import copies valid session JSONL files from `~/.pi/agent/sessions`, rewrites fork references and leaves originals untouched. Settings/accounts/extensions must be configured in the desktop. E2E-only isolated Pi directory compatibility is rejected by production packages.

Configuration mutations are gated per runtime, then only that runtime's workers refresh. A host exit settles its ownership; a later rejected request cannot reintroduce uncertainty for the dead instance. History listing works before any project is open. Combined listings sort pins before limits and identify lower-bound project counts when source pages are truncated.

## SDK projection and shared capabilities

Pi exposes desktop tools through its extension mechanism; Claude exposes desktop browser/computer/MCP tools through SDK MCP adapters. Main retains host-owned OS/browser behavior and mutation coordination. Native SDK tools use SDK hooks/canUseTool and the same approval and mutation protocols.

Claude Ask requests approval; Auto grants supported project edit tools while Bash still uses SDK approval; Open uses the SDK bypass mode. Capabilities describe implemented behavior, not parity promises.

Pi `session_task` allocates independent desktop workers. Claude `Agent` tasks remain SDK-owned, including child streams, saved child history and cancellation. Parent completion does not terminate child approvals or release child mutation leases. A complete SDK task notification updates child metadata and is excluded from user conversation bubbles; ordinary user messages remain intact.

Legacy `createWorker` factory support remains at the pool boundary for existing test adapters. New implementations use the runtime contract.

# Background session admission

Background agents reuse the same resident-session runtime as foreground conversations.

- `SessionWorkerPool.openBackground()` uses the normal serialized admission path, canonical cwd/session ownership checks, capacity limit, safe eviction rules, crash isolation and `AgentRuntime` implementation.
- Background admission never assigns desktop `selection`. Only an explicit `SessionWorkerSupervisor.select()` promotes a resident worker into the user's foreground conversation.
- `SessionWorkerSupervisor.openBackground()` publishes session summaries/worker monitoring updates, but it does not publish a foreground snapshot and does not call the `selected` callback.
- Commands for an admitted background worker go through `requestWorker()`, so they retain the same identity and capability boundaries as ordinary resident sessions.
- No second transcript or worker persistence model is introduced; Pi's canonical session remains the source of truth.

This primitive is intentionally orchestration-agnostic. Future Orchestrator/Subagent features may use it to create durable workers without coupling orchestration policy to Electron process management or stealing the user's current selection.

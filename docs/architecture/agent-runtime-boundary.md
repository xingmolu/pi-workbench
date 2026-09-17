# AgentRuntime boundary

`AgentRuntime` is the desktop-facing contract for one or more concrete Agent backends.

## Ownership

- `SessionWorkerPool` owns admission, residency, selection and request safety.
- `AgentRuntime` owns creation of a concrete session runtime.
- `AgentRuntimeSession` owns command transport and disposal for one resident session.
- `UtilityProcessAgentRuntime` is the current local implementation backed by one Electron `utilityProcess` per session.

Desktop orchestration must not depend on Electron child-process details or Pi SDK internals. New runtime implementations (for example remote execution) should implement `AgentRuntime` and preserve the same session identity, event and disposal semantics.

## Migration

Legacy `createWorker` factory options remain temporarily supported at the pool/supervisor boundary so existing Main wiring and tests can migrate incrementally. New code should provide `runtime` instead.

// Compatibility export while Main call sites migrate from the old controller name.
// New runtime code should depend on SessionWorkerSupervisor directly.
export { SessionWorkerSupervisor as SessionWorkerController } from './session-worker-supervisor'
export type {
  SessionWorkerSafety,
  SessionWorkerSupervisorOptions
} from './session-worker-supervisor'

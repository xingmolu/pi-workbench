// Compatibility export while Main call sites migrate to the generic broker name.
export { CapabilityBroker as WorkerMutationCapabilities } from './capability-broker'
export type {
  ForegroundCapabilityToken,
  SessionCapabilityIdentity
} from './capability-broker'

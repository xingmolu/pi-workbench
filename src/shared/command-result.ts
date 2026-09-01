import type { HostCommand, HostResult } from './contracts'

export function expectedHostResultKind(command: HostCommand): HostResult['kind'] {
  switch (command.type) {
    case 'bootstrap':
    case 'state:get':
    case 'project:open':
    case 'session:new':
    case 'session:open':
      return 'snapshot'
    case 'prompt:send':
    case 'prompt:abort':
    case 'queue:clear':
    case 'permission:set':
    case 'permission:respond':
    case 'account:login':
    case 'account:login:respond':
    case 'account:alias:add':
    case 'model:set':
      return 'ack'
  }
}

export function hostResultMatchesCommand(command: HostCommand, result: HostResult): boolean {
  return result.kind === expectedHostResultKind(command)
}

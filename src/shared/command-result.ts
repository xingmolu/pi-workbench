import type { HostCommand, HostResult } from './contracts'

export function expectedHostResultKind(command: HostCommand): HostResult['kind'] {
  switch (command.type) {
    case 'project:catalog':
      return 'project-catalog'
    case 'session:edit:prepare':
    case 'session:edit:cancel':
    case 'session:edit:send':
    case 'session:edit:query':
      return 'session-edit'
    case 'session:fork':
      return 'session-fork'
    case 'attachment:prompt':
    case 'attachment:query':
      return 'attachment'
    case 'endpoint:list':
      return 'endpoint-list'
    case 'endpoint:save':
      return 'endpoint-save'
    case 'bootstrap':
    case 'state:get':
    case 'project:open':
    case 'project:navigate':
    case 'session:new':
    case 'session:open':
      return 'snapshot'
    case 'prompt:send':
    case 'message:feedback':
    case 'session:rename':
    case 'prompt:abort':
    case 'queue:clear':
    case 'permission:set':
    case 'permission:respond':
    case 'account:login':
    case 'account:login:respond':
    case 'account:alias:add':
    case 'model:set':
    case 'browser:e2e':
      return 'ack'
  }
}

export function hostResultMatchesCommand(command: HostCommand, result: HostResult): boolean {
  return result.kind === expectedHostResultKind(command)
}

import { Type } from 'typebox'
import { COMPUTER_USE_KEYS } from '../shared/computer-use'

// Anthropic-compatible providers in Pi project only root properties/required.
// A root union becomes an empty object on the wire. Keep provider parameters
// object-shaped; computerUseOperationSchema enforces each operation at execution.
export const COMPUTER_USE_TOOL_PARAMETERS = Type.Object({
  action: Type.Union(
    [
      Type.Literal('observe'),
      Type.Literal('activate'),
      Type.Literal('search'),
      Type.Literal('inspect'),
      Type.Literal('act')
    ],
    {
      description:
        'Required. Start with {"action":"observe"} to obtain a current stateId, or {"action":"activate","app":"Name"} to open/switch to an app first.'
    }
  ),
  app: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 80,
      description:
        'Required for activate only: the app name as shown in the Dock (e.g. "HoYowave") or its bundle id.'
    })
  ),
  mode: Type.Optional(
    Type.Union([Type.Literal('semantic'), Type.Literal('visual'), Type.Literal('fused')], {
      description:
        'Only for observe and activate; defaults to fused. Observes the focused foreground window; observe again after a window switch.'
    })
  ),
  stateId: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 80,
      description: 'Required for search, inspect and act. Use the current observation stateId.'
    })
  ),
  query: Type.Optional(
    Type.String({ minLength: 1, maxLength: 200, description: 'Required for search only.' })
  ),
  ref: Type.Optional(
    Type.String({
      pattern: '^@e[1-9]\\d*$',
      description: 'Required for inspect only. For act, put the ref inside target.'
    })
  ),
  target: Type.Optional(
    Type.Union(
      [
        Type.Object({ kind: Type.Literal('ref'), ref: Type.String({ pattern: '^@e[1-9]\\d*$' }) }),
        Type.Object({
          kind: Type.Literal('point'),
          x: Type.Number({ minimum: 0, maximum: 10000 }),
          y: Type.Number({ minimum: 0, maximum: 10000 })
        })
      ],
      {
        description:
          'Required for act except intent=key. Prefer a current ref; point uses the current screenshot pixels.'
      }
    )
  ),
  intent: Type.Optional(
    Type.Union(
      [Type.Literal('press'), Type.Literal('move'), Type.Literal('type'), Type.Literal('key')],
      {
        description:
          'Required for act only. type focuses the target before entering text; do not press it separately first. key presses one key in the observed window.'
      }
    )
  ),
  key: Type.Optional(
    Type.Union(
      COMPUTER_USE_KEYS.map((key) => Type.Literal(key)),
      { description: 'Required for act with intent=key, e.g. Enter to send or submit.' }
    )
  ),
  text: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 200,
      description: 'Text to enter for act with intent=type. Omit for other operations.'
    })
  )
})

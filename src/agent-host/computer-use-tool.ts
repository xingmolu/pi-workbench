import { Type, type TSchema } from 'typebox'

import { COMPUTER_USE_LIMITS } from '../shared/computer-use'

function actionTarget(description: string): TSchema {
  return Type.Union(
    [
      Type.Object({ kind: Type.Literal('ref'), ref: Type.String({ pattern: '^@e[1-9]\\d*$' }) }),
      Type.Object({
        kind: Type.Literal('point'),
        x: Type.Number({ minimum: 0, maximum: 10000 }),
        y: Type.Number({ minimum: 0, maximum: 10000 })
      })
    ],
    { description }
  )
}

const INTENT = Type.Union(
  [
    Type.Literal('press'),
    Type.Literal('move'),
    Type.Literal('type'),
    Type.Literal('key'),
    Type.Literal('scroll'),
    Type.Literal('drag'),
    Type.Literal('paste'),
    Type.Literal('set_value'),
    Type.Literal('secondary')
  ],
  {
    description:
      'For act. press clicks; type focuses target then types up to 200 characters; paste inserts longer text through the clipboard (restored afterwards); key presses a key or shortcut; scroll needs direction; drag goes from target to `to`; set_value writes a text field, slider or picker value directly (ref only); secondary performs menu/increment/decrement/pick/confirm/cancel on target.'
  }
)

const STEP_FIELDS = {
  to: Type.Optional(actionTarget('Where a drag ends.')),
  text: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: COMPUTER_USE_LIMITS.maxPasteLength,
      description: 'Text for intent=type (up to 200 characters) or intent=paste.'
    })
  ),
  key: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 40,
      description:
        'For intent=key: a named key (Enter, Escape, Tab, Backspace, Delete, Space, ArrowUp/Down/Left/Right, PageUp, PageDown, Home, End, F1-F12) or a shortcut such as cmd+s, cmd+shift+z, ctrl+a. Shortcuts that switch or quit apps are refused.'
    })
  ),
  direction: Type.Optional(
    Type.Union(
      [Type.Literal('up'), Type.Literal('down'), Type.Literal('left'), Type.Literal('right')],
      { description: 'For intent=scroll.' }
    )
  ),
  amount: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: COMPUTER_USE_LIMITS.maxScrollAmount,
      description: 'For intent=scroll: how far, in wheel notches of three lines; defaults to 3.'
    })
  ),
  value: Type.Optional(
    Type.String({
      maxLength: COMPUTER_USE_LIMITS.maxValueLength,
      description: 'For intent=set_value: the new value.'
    })
  ),
  name: Type.Optional(
    Type.Union(
      [
        Type.Literal('menu'),
        Type.Literal('increment'),
        Type.Literal('decrement'),
        Type.Literal('pick'),
        Type.Literal('confirm'),
        Type.Literal('cancel')
      ],
      { description: 'For intent=secondary: the accessibility action to perform.' }
    )
  )
}

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
      Type.Literal('act'),
      Type.Literal('apps'),
      Type.Literal('windows')
    ],
    {
      description:
        'Required. Start with {"action":"observe"} to obtain a current stateId, or {"action":"activate","app":"Name"} to open/switch to an app first. apps lists running apps; windows lists the windows of one app.'
    }
  ),
  app: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 80,
      description:
        'Required for activate and windows: the app name as shown in the Dock (e.g. "HoYowave") or its bundle id.'
    })
  ),
  window: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 200,
      description:
        'Optional for activate: part of the title of the window to bring forward (see action windows).'
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
  intent: Type.Optional(INTENT),
  target: Type.Optional(
    actionTarget(
      'The element an act works on: required for press, move, drag, set_value and secondary; optional for type/paste (focused first) and scroll (window centre otherwise). Prefer a current ref; point uses the current screenshot pixels.'
    )
  ),
  ...STEP_FIELDS,
  steps: Type.Optional(
    Type.Array(
      Type.Object({
        intent: INTENT,
        ...STEP_FIELDS,
        target: Type.Optional(actionTarget('As target above.'))
      }),
      {
        minItems: 1,
        maxItems: COMPUTER_USE_LIMITS.maxSteps,
        description:
          'For act instead of intent: several steps run in order against the same stateId, e.g. type into a field, then key Enter. Each step takes intent plus its own target/text/key/...; refs come from the observation before the first step. One observation follows the last step.'
      }
    )
  )
})

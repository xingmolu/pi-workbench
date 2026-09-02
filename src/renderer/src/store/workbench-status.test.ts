import { describe, expect, it } from 'vitest'
import type { WorkbenchSnapshot } from '../../../shared/contracts'
import { INITIAL_WORKBENCH_STATUS, workbenchStatusReducer } from './workbench-status'

const READY_SNAPSHOT: WorkbenchSnapshot = {
  revision: 4,
  plugins: [],
  contributions: [],
  diagnostics: []
}

describe('scoped Workbench status', () => {
  it('clears a Workbench failure when a later snapshot succeeds', () => {
    const failed = workbenchStatusReducer(INITIAL_WORKBENCH_STATUS, {
      type: 'error',
      message: 'Workbench 尚未就绪'
    })

    expect(failed.error).toBe('工作台：Workbench 尚未就绪')

    expect(workbenchStatusReducer(failed, { type: 'snapshot', snapshot: READY_SNAPSHOT })).toEqual({
      snapshot: READY_SNAPSHOT,
      error: null
    })
  })

  it('clears an existing failure after a Workbench command succeeds', () => {
    const failed = workbenchStatusReducer(INITIAL_WORKBENCH_STATUS, {
      type: 'error',
      message: '面板操作失败'
    })

    expect(workbenchStatusReducer(failed, { type: 'clear' })).toEqual({
      snapshot: INITIAL_WORKBENCH_STATUS.snapshot,
      error: null
    })
  })
})

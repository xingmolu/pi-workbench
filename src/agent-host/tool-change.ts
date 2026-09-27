import { createTwoFilesPatch, structuredPatch } from 'diff'
import type { ToolFileChange } from '../shared/contracts'

/** Larger patches keep their line counts but are not shipped to the Renderer. */
export const MAX_TOOL_CHANGE_PATCH = 200_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

type Replacement = { oldText: string; newText: string }

function isReplacement(value: unknown): value is Replacement {
  return isRecord(value) && typeof value.oldText === 'string' && typeof value.newText === 'string'
}

/** Mirrors the argument shapes Pi's edit tool accepts, without applying its repairs to disk. */
function replacements(args: Record<string, unknown>): Replacement[] | null {
  let edits: unknown = args.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits)
    } catch {
      return null
    }
  }
  const list: Replacement[] = Array.isArray(edits)
    ? edits.filter(isReplacement)
    : isReplacement(edits)
      ? [edits]
      : []
  if (isReplacement(args)) list.push({ oldText: args.oldText, newText: args.newText })
  return list.length ? list : null
}

function countLines(patch: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) additions += 1
    else if (line.startsWith('-')) deletions += 1
  }
  return { additions, deletions }
}

function bounded(
  change: Omit<ToolFileChange, 'additions' | 'deletions' | 'patch'> & { patch: string }
): ToolFileChange {
  const counts = countLines(change.patch)
  if (change.patch.length <= MAX_TOOL_CHANGE_PATCH) return { ...change, ...counts }
  return { ...change, ...counts, patch: '', omitted: true }
}

function toolPath(args: Record<string, unknown>): string | null {
  for (const key of ['path', 'filePath']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/** Proposed change from the model's arguments. Edit hunks are located against the snippet,
 * not the file, so their line numbers are not file positions (`anchored: false`). */
export function proposedToolChange(name: string, rawArgs: unknown): ToolFileChange | undefined {
  if (!isRecord(rawArgs)) return undefined
  const path = toolPath(rawArgs)
  if (!path) return undefined
  if (name === 'write') {
    const content = rawArgs.content
    if (typeof content !== 'string') return undefined
    return bounded({
      path,
      kind: 'write',
      source: 'proposed',
      anchored: false,
      patch: createTwoFilesPatch(path, path, '', content, undefined, undefined, { context: 0 })
    })
  }
  if (name !== 'edit') return undefined
  const edits = replacements(rawArgs)
  if (!edits) return undefined
  const hunks = edits.flatMap(
    (edit) =>
      structuredPatch(path, path, edit.oldText, edit.newText, undefined, undefined, {
        context: 3
      }).hunks
  )
  if (!hunks.length) return undefined
  // Each snippet restarts at line 1; lay hunks out sequentially so the patch stays valid.
  let oldCursor = 0
  let newCursor = 0
  const body = hunks.map((hunk) => {
    const oldStart = oldCursor + hunk.oldStart
    const newStart = newCursor + hunk.newStart
    oldCursor = oldStart + hunk.oldLines
    newCursor = newStart + hunk.newLines
    return [
      `@@ -${oldStart},${hunk.oldLines} +${newStart},${hunk.newLines} @@`,
      ...hunk.lines
    ].join('\n')
  })
  return bounded({
    path,
    kind: 'edit',
    source: 'proposed',
    anchored: false,
    patch: [`--- ${path}`, `+++ ${path}`, ...body, ''].join('\n')
  })
}

/** Pi's edit tool reports the exact applied unified patch in result details. */
export function appliedToolChange(
  name: string,
  details: unknown,
  path?: string
): ToolFileChange | undefined {
  if (name !== 'edit' || !isRecord(details)) return undefined
  const patch = details.patch
  if (typeof patch !== 'string' || !patch.trim()) return undefined
  const target = path ?? /^\+\+\+ (.+)$/m.exec(patch)?.[1]?.trim()
  if (!target) return undefined
  return bounded({ path: target, kind: 'edit', source: 'applied', anchored: true, patch })
}

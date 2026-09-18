import type { ApprovalRequest } from '../../../shared/contracts'

/** Never infer command safety or discard unknown parameters from an approval. */
export function approvalPreview(request: ApprovalRequest): {
  label: string
  text: string
  parameters: string | null
} {
  const raw = request.detail || request.title
  let input: Record<string, unknown> | null = null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
      input = parsed as Record<string, unknown>
  } catch {
    /* A tool is allowed to supply plain text instead of JSON. */
  }

  if (request.intent === 'terminal' && input && typeof input.command === 'string') {
    return {
      label: '将执行的命令',
      text: input.command,
      // Additional cwd/env/timeout/unknown fields must remain visible by default.
      parameters: Object.keys(input).some((key) => key !== 'command') ? raw : null
    }
  }
  return {
    label:
      request.intent === 'diff'
        ? '将修改的文件与内容'
        : request.intent === 'web'
          ? '网页操作详情'
          : request.intent === 'desktop'
            ? '桌面操作详情'
            : '操作详情',
    text: raw,
    parameters: null
  }
}

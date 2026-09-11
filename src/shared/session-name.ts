export function normalizeSessionName(name: string): string {
  if (name.length > 4096) throw new Error('会话名称输入过长')
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(name)) {
    throw new Error('会话名称不能包含控制字符或换行')
  }
  const normalized = name.trim()
  if (!normalized) throw new Error('会话名称不能为空')
  if ([...normalized].length > 80) throw new Error('会话名称不能超过 80 个字符')
  return normalized
}

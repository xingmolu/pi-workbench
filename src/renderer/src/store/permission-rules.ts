import type { PermissionRules } from '../../../shared/permission-rules'

export async function savePermissionRules(
  projectPath: string,
  rules: PermissionRules
): Promise<void> {
  await window.pi.send({ type: 'permission:rules:set', projectPath, rules })
}

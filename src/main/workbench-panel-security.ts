import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const STRICT_WORKBENCH_PANEL_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  "font-src 'self'",
  "media-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath)
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  )
}

export async function canonicalWorkbenchPanelFile(
  url: string,
  canonicalRootPath: string
): Promise<string | null> {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:') return null
    const candidatePath = await realpath(fileURLToPath(parsed))
    if (!isPathInside(canonicalRootPath, candidatePath)) return null
    return (await stat(candidatePath)).isFile() ? candidatePath : null
  } catch {
    return null
  }
}

export function isPotentialWorkbenchPanelNavigation(
  url: string,
  canonicalRootPath: string
): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:') return false
    return isPathInside(canonicalRootPath, fileURLToPath(parsed))
  } catch {
    return false
  }
}

/**
 * manifest.json plugin pages commonly use inline scripts. Plugins loaded from its manifest get
 * this variant; everything else (no network, files only from the plugin root, no Node)
 * stays the same.
 */
export const PI_DESKTOP_COMPAT_PANEL_CSP = STRICT_WORKBENCH_PANEL_CSP.replace(
  "script-src 'self'",
  "script-src 'self' 'unsafe-inline'"
)

export function secureWorkbenchPanelResponseHeaders(
  responseHeaders: Readonly<Record<string, string[]>> | undefined,
  options: { inlineScripts?: boolean } = {}
): Record<string, string[]> {
  const securityHeaders = new Set([
    'content-security-policy',
    'x-content-type-options',
    'referrer-policy'
  ])
  const headers = Object.fromEntries(
    Object.entries(responseHeaders ?? {})
      .filter(([name]) => !securityHeaders.has(name.toLowerCase()))
      .map(([name, values]) => [name, [...values]])
  )
  return {
    ...headers,
    'Content-Security-Policy': [
      options.inlineScripts ? PI_DESKTOP_COMPAT_PANEL_CSP : STRICT_WORKBENCH_PANEL_CSP
    ],
    'X-Content-Type-Options': ['nosniff'],
    'Referrer-Policy': ['no-referrer']
  }
}

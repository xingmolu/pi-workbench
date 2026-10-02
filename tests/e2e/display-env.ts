/**
 * Variables the app needs from the host to start at all, for specs that build a clean
 * environment: the X display (and its auth file) on Linux CI under xvfb-run, and the system
 * directories Windows processes expect.
 */
export function displayEnv(): Record<string, string> {
  const keep = [
    'DISPLAY',
    'XAUTHORITY',
    'WAYLAND_DISPLAY',
    ...(process.platform === 'win32'
      ? ['SystemRoot', 'SYSTEMROOT', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT', 'ProgramData']
      : [])
  ]
  const env: Record<string, string> = {}
  for (const key of keep) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  return env
}

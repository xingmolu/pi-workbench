/**
 * Electron needs the X display (and its auth file) to start on Linux CI under xvfb-run. Specs
 * that build a clean environment for the app must pass these through explicitly.
 */
export function displayEnv(): Record<string, string> {
  return {
    ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
    ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}),
    ...(process.env.WAYLAND_DISPLAY ? { WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY } : {})
  }
}

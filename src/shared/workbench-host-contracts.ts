/** Trusted Agent Host -> Main discovery data. Never expose these paths to a plugin panel. */
export type PiPackageRoot = {
  path: string
  source: string
  scope: 'user' | 'project'
  hasExecutablePiResources: boolean
}

export type PiPackageRootsMessage = {
  type: 'desktop-plugin-roots'
  sessionId: string | null
  generation: number
  roots: PiPackageRoot[]
}

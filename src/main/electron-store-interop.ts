export type ElectronStoreConstructor = typeof import('electron-store').default

export async function loadElectronStoreConstructor(): Promise<ElectronStoreConstructor> {
  const module = await import('electron-store')
  return module.default
}

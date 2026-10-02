import type { PromptImage } from '../../../shared/contracts'
import { t } from '../../../shared/i18n'

export const MAX_IMAGES = 4
const MAX_EDGE = 1600
const KEEP_BYTES = 1.5 * 1024 * 1024

export type DraftImage = PromptImage & { id: string; preview: string; name: string }

function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

/**
 * Phone photos are large; downscale to a 1600px edge as JPEG so a prompt with four of them
 * stays well under the gateway's upload limit. Small PNG/GIF/WebP files are kept as they are.
 */
export async function prepareImage(file: File): Promise<DraftImage> {
  const id = crypto.randomUUID()
  const type = file.type as PromptImage['mimeType']
  if (
    !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type) &&
    !file.type.startsWith('image/')
  )
    throw new Error(t('只能添加图片'))
  const bitmap = await createImageBitmap(file).catch(() => null)
  const keep =
    ['image/png', 'image/webp', 'image/gif', 'image/jpeg'].includes(type) &&
    file.size <= KEEP_BYTES &&
    (!bitmap || Math.max(bitmap.width, bitmap.height) <= MAX_EDGE)
  if (keep || !bitmap) {
    if (!bitmap && !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type))
      throw new Error(t('无法读取这张图片'))
    bitmap?.close()
    const data = base64(await file.arrayBuffer())
    return { id, name: file.name, mimeType: type, data, preview: `data:${type};base64,${data}` }
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const preview = canvas.toDataURL('image/jpeg', 0.85)
  return {
    id,
    name: file.name,
    mimeType: 'image/jpeg',
    data: preview.slice(preview.indexOf(',') + 1),
    preview
  }
}

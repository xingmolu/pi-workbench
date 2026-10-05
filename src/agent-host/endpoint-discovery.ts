import {
  MAX_ENDPOINT_MODELS,
  endpointDiscoverSchema,
  type EndpointDiscoverCommand,
  type EndpointDiscovery
} from '../shared/custom-endpoints'
import { t } from '../shared/i18n'

export function modelsUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  const path = url.pathname
    .replace(/\/+$/, '')
    .replace(/\/(chat\/completions|responses|messages|models)$/, '')
  url.pathname = `${path || '/v1'}/models`
  return url.href
}

/** Fetch in the host, never the renderer; do not forward credentials through redirects. */
export async function discoverEndpointModels(
  input: EndpointDiscoverCommand,
  fetcher: typeof fetch = fetch
): Promise<EndpointDiscovery> {
  const request = endpointDiscoverSchema.parse(input)
  const headers: Record<string, string> =
    request.api === 'anthropic-messages'
      ? { 'x-api-key': request.key, 'anthropic-version': '2023-06-01' }
      : { Authorization: `Bearer ${request.key}` }
  let response: Response
  try {
    response = await fetcher(modelsUrl(request.baseUrl), {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(15000)
    })
  } catch {
    throw new Error(t('无法连接模型列表，请检查地址和网络后重试，或手动填写模型。'))
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(
      response.status === 401 || response.status === 403
        ? t('认证失败，请检查 API Key 和访问权限。')
        : t('模型列表请求失败（HTTP {status}），可在高级设置中手动填写模型。', {
            status: response.status
          })
    )
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error(t('服务未返回模型列表。'))
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 2 * 1024 * 1024) throw new Error(t('模型列表过大，请手动填写模型。'))
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  let data: unknown
  try {
    data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error(t('服务返回的不是有效模型列表，可手动填写模型。'))
  }
  const rows = data && typeof data === 'object' && 'data' in data ? data.data : null
  if (!Array.isArray(rows)) throw new Error(t('服务不支持标准模型列表，可手动填写模型。'))
  const ids = [
    ...new Set(
      rows.flatMap((row) => {
        const id = row?.id
        return typeof id === 'string' &&
          id.trim() &&
          [...id].length <= 200 &&
          !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(id)
          ? [id.trim()]
          : []
      })
    )
  ]
  if (!ids.length) throw new Error(t('未发现可用模型，请检查此密钥的模型权限，或手动填写。'))
  return {
    baseUrl: modelsUrl(request.baseUrl).replace(/\/models$/, ''),
    modelIds: ids.slice(0, MAX_ENDPOINT_MODELS),
    truncated:
      ids.length > MAX_ENDPOINT_MODELS || (data as { has_more?: boolean }).has_more === true
  }
}

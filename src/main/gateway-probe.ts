import { discoverEndpointModels } from '../agent-host/endpoint-discovery'
import {
  gatewayProbeInputSchema,
  type GatewayProbe,
  type GatewayProbeInput
} from '../shared/gateway'
import type { EndpointDiscovery } from '../shared/custom-endpoints'
import { t } from '../shared/i18n'

const ANTHROPIC_VERSION = '2023-06-01'

const unique = (values: string[]): string[] => [...new Set(values)]

/**
 * Whether a POST route exists: an empty request should be refused for what it lacks (400,
 * 422…) with a JSON error. Missing routes answer 404/405, and some gateways answer unknown
 * paths with their web page instead, so a non-JSON reply does not count either.
 */
async function answers(
  fetcher: typeof fetch,
  url: string,
  headers: Record<string, string>
): Promise<number | null> {
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: '{}',
      redirect: 'error',
      signal: AbortSignal.timeout(6_000)
    })
    const json = (response.headers.get('content-type') ?? '').includes('json')
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 404 || response.status === 405 || response.status >= 500) return null
    return json || response.status === 401 || response.status === 403 ? response.status : null
  } catch {
    return null
  }
}

const denied = (status: number | null): boolean => status === 401 || status === 403

/**
 * Finds what a gateway speaks from one address and key: the OpenAI-compatible API (its model
 * list, Chat Completions and Responses) and the Anthropic Messages API, trying the paths
 * gateways commonly use (`/v1`, the root, `/anthropic`) and both ways of sending the key.
 * Nothing here spends tokens: requests carry an empty body, which a real route refuses.
 */
export async function probeGateway(
  input: GatewayProbeInput,
  fetcher: typeof fetch = fetch
): Promise<GatewayProbe> {
  const { baseUrl, key } = gatewayProbeInputSchema.parse(input)
  const given = baseUrl
    .replace(/\/+$/, '')
    .replace(/\/(chat\/completions|responses|messages|models)$/, '')
    .replace(/\/+$/, '')
  const root = given.replace(/\/v1$/, '')
  const anthropicPath = /\/anthropic$/.test(root)
  const outside = anthropicPath ? root.replace(/\/anthropic$/, '') : root
  const openaiCandidates = unique([
    given.endsWith('/v1') ? given : `${given}/v1`,
    ...(anthropicPath ? [`${outside}/v1`] : [given])
  ])
  const anthropicCandidates = unique(anthropicPath ? [root] : [root, `${root}/anthropic`])

  const bearer = { Authorization: `Bearer ${key}` }
  /** The Anthropic route at one base: with `x-api-key`, else as a bearer token. */
  const anthropicAt = async (candidate: string): Promise<GatewayProbe['anthropic']> => {
    const url = `${candidate}/v1/messages`
    const withKey = await answers(fetcher, url, {
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION
    })
    if (withKey !== null && !denied(withKey)) return { baseUrl: candidate, auth: 'x-api-key' }
    if (!denied(withKey)) return null
    // Many gateways take the key only as a bearer token, even on their Anthropic route.
    const withBearer = await answers(fetcher, url, {
      ...bearer,
      'anthropic-version': ANTHROPIC_VERSION
    })
    return withBearer !== null && !denied(withBearer)
      ? { baseUrl: candidate, auth: 'bearer' }
      : null
  }
  /** The first OpenAI-compatible base whose model list answers. */
  const openaiModels = async (): Promise<{
    models: EndpointDiscovery | null
    failure: unknown
  }> => {
    let failure: unknown = null
    for (const candidate of openaiCandidates) {
      try {
        return {
          models: await discoverEndpointModels(
            { type: 'endpoint:discover', baseUrl: candidate, key, api: 'openai-completions' },
            fetcher
          ),
          failure
        }
      } catch (error) {
        failure ??= error
      }
    }
    return { models: null, failure }
  }
  // Both APIs at once: an unanswered request costs its timeout only once.
  const [found, anthropics] = await Promise.all([
    openaiModels().then(async (result) => {
      if (!result.models) return { ...result, openai: null }
      const [chat, responses] = await Promise.all([
        answers(fetcher, `${result.models.baseUrl}/chat/completions`, bearer),
        answers(fetcher, `${result.models.baseUrl}/responses`, bearer)
      ])
      return {
        ...result,
        openai: {
          baseUrl: result.models.baseUrl,
          chat: chat !== null && !denied(chat),
          responses: responses !== null && !denied(responses)
        }
      }
    }),
    Promise.all(anthropicCandidates.map(anthropicAt))
  ])
  let models = found.models
  const failure = found.failure
  const openai: GatewayProbe['openai'] = found.openai
  const anthropic: GatewayProbe['anthropic'] = anthropics.find((item) => item !== null) ?? null

  if (!models && anthropic?.auth === 'x-api-key') {
    try {
      models = await discoverEndpointModels(
        {
          type: 'endpoint:discover',
          baseUrl: `${anthropic.baseUrl}/v1`,
          key,
          api: 'anthropic-messages'
        },
        fetcher
      )
    } catch {
      // Claude Code lists the models itself; Pi's would be typed in by hand.
    }
  }
  if (!openai && !anthropic)
    throw failure instanceof Error
      ? failure
      : new Error(t('没有识别出这个服务的接口，请检查地址和 API Key。'))
  return {
    openai,
    anthropic,
    modelIds: models?.modelIds ?? [],
    truncated: models?.truncated ?? false
  }
}

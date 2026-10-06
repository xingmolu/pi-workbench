import { createServer, type Server } from 'node:http'

/**
 * A local stand-in for the OpenAI Responses API. Tests run the real Codex CLI against it through
 * a custom model provider, so nothing leaves the machine. A prompt containing `run command`
 * makes the model call `exec_command` first; every prompt ends with a short reply.
 */
export async function createResponsesFixture(options: { command?: string } = {}) {
  const requests: { authorization?: string; model?: string; input: unknown[] }[] = []
  let sequence = 0
  const server: Server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    // Like a gateway, it lists its models and refuses an empty request with a JSON error.
    if (request.method === 'GET' && request.url?.endsWith('/v1/models')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }))
      return
    }
    if (!request.url?.endsWith('/responses')) {
      response.writeHead(404)
      response.end()
      return
    }
    const payload = JSON.parse(body || '{}') as { input?: unknown[]; model?: string }
    if (!payload.model) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'model is required' } }))
      return
    }
    const input = payload.input ?? []
    requests.push({
      ...(typeof request.headers.authorization === 'string'
        ? { authorization: request.headers.authorization }
        : {}),
      ...(payload.model ? { model: payload.model } : {}),
      input
    })
    const id = `resp_${++sequence}`
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (event: Record<string, unknown>): void => {
      response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    }
    send({ type: 'response.created', response: { id } })
    // Only the newest user message decides; earlier turns stay in the history Codex resends.
    const last = input.at(-1) as { type?: string; role?: string } | undefined
    const asked = last?.role === 'user' && JSON.stringify(last).includes('run command')
    if (asked) {
      send({
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          id: `fc_${sequence}`,
          call_id: `call_${sequence}`,
          name: 'exec_command',
          arguments: JSON.stringify({ cmd: options.command ?? 'echo fixture > made-by-codex.txt' })
        }
      })
    } else {
      const message = `msg_${sequence}`
      send({
        type: 'response.output_item.added',
        item: { type: 'message', role: 'assistant', id: message, content: [] }
      })
      for (const delta of ['Codex ', 'fixture ', 'reply.'])
        send({
          type: 'response.output_text.delta',
          item_id: message,
          delta,
          output_index: 0,
          content_index: 0
        })
      send({
        type: 'response.output_item.done',
        item: {
          type: 'message',
          role: 'assistant',
          id: message,
          content: [{ type: 'output_text', text: 'Codex fixture reply.' }]
        }
      })
    }
    send({
      type: 'response.completed',
      response: {
        id,
        usage: {
          input_tokens: 120,
          input_tokens_details: null,
          output_tokens: 8,
          output_tokens_details: null,
          total_tokens: 128
        }
      }
    })
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    requests,
    /** The OpenAI-compatible base, as a gateway connection names it. */
    baseUrl: `http://127.0.0.1:${port}/v1`,
    /** `-c` overrides that make Codex use this server for every turn. */
    config: [
      'model_provider="fixture"',
      `model_providers.fixture={ name = "fixture", base_url = "http://127.0.0.1:${port}/v1", wire_api = "responses", requires_openai_auth = false }`,
      'model="fixture-model"',
      // Offline: no ChatGPT connectors and no analytics.
      'features.apps=false',
      'analytics.enabled=false'
    ],
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

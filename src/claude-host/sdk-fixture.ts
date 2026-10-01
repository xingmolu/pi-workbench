import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
/** Local Anthropic protocol server. Tests run the real SDK and bundled CLI against it. */
export async function createClaudeHttpFixture(options: {
  cwd: string
  delayMs?: number
  childDelayMs?: number
  streamDelayMs?: number
}) {
  const requests: { path: string; body: Record<string, unknown>; apiKey?: string }[] = []
  let sequence = 0
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>
    const apiKey = request.headers['x-api-key']
    requests.push({
      path: request.url ?? '',
      body,
      ...(typeof apiKey === 'string' ? { apiKey } : {})
    })
    if (request.url?.includes('count_tokens')) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ input_tokens: 100 }))
      return
    }
    if (!request.url?.includes('/messages')) {
      response.setHeader('content-type', 'application/json')
      response.end('{}')
      return
    }
    const messages = body.messages as { role: string; content: unknown }[]
    const last = messages?.filter((message) => message.role === 'user').at(-1)
    const text = JSON.stringify(last?.content ?? '')
    const childPrompt =
      last?.content === 'child fixture' ||
      (Array.isArray(last?.content) &&
        last.content.some((block) => block?.type === 'text' && block.text === 'child fixture'))
    const isToolResult = text.includes('tool_result')
    let blocks: Block[] = [{ type: 'text', text: 'Claude fixture reply.' }]
    if (!isToolResult && text.includes('write fixture'))
      blocks = [
        {
          type: 'tool_use',
          id: `tool_${++sequence}`,
          name: 'Write',
          input: { file_path: `${options.cwd}/fixture.txt`, content: 'Native SDK wrote this.\n' }
        }
      ]
    if (
      !isToolResult &&
      (text.includes('spawn fixture') || text.includes('spawn background fixture'))
    )
      blocks = [
        {
          type: 'tool_use',
          id: `agent_${++sequence}`,
          name: 'Agent',
          input: {
            description: 'Inspect fixture child',
            prompt: 'child fixture',
            subagent_type: 'general-purpose',
            ...(text.includes('spawn background fixture') ? { run_in_background: true } : {})
          }
        }
      ]
    if (!isToolResult && childPrompt)
      blocks = [{ type: 'text', text: 'Private child fixture reply.' }]
    if (!isToolResult && text.includes('plugin fixture'))
      blocks = [
        {
          type: 'tool_use',
          id: `plugin_${++sequence}`,
          name: 'mcp__desktop__fixture_echo',
          input: { value: 'hello' }
        }
      ]
    if (!isToolResult && text.includes('browser fixture'))
      blocks = [
        {
          type: 'tool_use',
          id: `browser_${++sequence}`,
          name: 'mcp__desktop__browser',
          input: { operation: { action: 'tabs' } }
        }
      ]
    if (!isToolResult && text.includes('long fixture'))
      blocks = [
        {
          type: 'text',
          text:
            '# Claude streaming fixture\n\n' +
            'This paragraph verifies native streaming text and stable final message identity.\n\n'.repeat(
              8
            )
        }
      ]
    const message = {
      id: `msg_${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: blocks,
      stop_reason: blocks[0]?.type === 'tool_use' ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 8,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      }
    }
    const delay = childPrompt ? (options.childDelayMs ?? options.delayMs) : options.delayMs
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
    if (response.destroyed) return
    if (!body.stream) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(message))
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': randomUUID() })
    const event = (type: string, data: unknown) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
    event('message_start', {
      type: 'message_start',
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: { ...message.usage, output_tokens: 0 }
      }
    })
    for (const [index, block] of blocks.entries()) {
      event('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} }
      })
      if (block.type === 'text' && options.streamDelayMs) {
        for (let offset = 0; offset < block.text.length; offset += 4) {
          if (response.destroyed) return
          event('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'text_delta', text: block.text.slice(offset, offset + 4) }
          })
          await new Promise((resolve) => setTimeout(resolve, options.streamDelayMs))
        }
      } else
        event('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta:
            block.type === 'text'
              ? { type: 'text_delta', text: block.text }
              : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
        })
      event('content_block_stop', { type: 'content_block_stop', index })
    }
    event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: 8 }
    })
    event('message_stop', { type: 'message_stop' })
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture address missing')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }
}

import { appendFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

function fixture() {
  const server = new McpServer({ name: 'isolated-e2e', version: '1.0.0' })
  server.registerTool('echo', { inputSchema: { text: z.string() } }, async ({ text }) => ({
    content: [{ type: 'text', text }]
  }))
  server.registerTool('failing', { inputSchema: {} }, async () => ({
    isError: true,
    content: [{ type: 'text', text: 'fixture failure' }]
  }))
  server.registerTool('side_effect', { inputSchema: { text: z.string() } }, async ({ text }) => {
    await appendFile(process.env.MCP_SENTINEL, text + '\n')
    return { content: [{ type: 'text', text: 'sentinel written' }] }
  })
  server.registerTool('slow', { inputSchema: {} }, async (_, extra) => {
    await writeFile(process.env.MCP_STARTED, 'started')
    await new Promise((resolve) => extra.signal.addEventListener('abort', resolve, { once: true }))
    return { content: [{ type: 'text', text: 'cancelled' }] }
  })
  return server
}

if (process.argv.includes('--http')) {
  const http = createServer(async (req, res) => {
    const server = fixture()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res)
  })
  http.listen(0, '127.0.0.1', () =>
    process.stdout.write(`http://127.0.0.1:${http.address().port}/mcp\n`)
  )
} else {
  await fixture().connect(new StdioServerTransport())
}

// Diagnostic v2: instrument DOM + renderer events while switching sidebar sessions.
import { _electron as electron } from 'playwright'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-flash2-')))
let app
try {
  const a = join(root, 'one', 'studio')
  const b = join(root, 'two', 'studio')
  const agentDir = join(root, 'agent')
  const bucket = (cwd) =>
    join(agentDir, 'sessions', `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`)
  for (const path of [
    a,
    b,
    join(root, 'home'),
    join(root, 'user-data'),
    join(agentDir, 'extensions')
  ])
    await mkdir(path, { recursive: true })

  const seed = async (cwd, id, title, index, paragraphs) => {
    await mkdir(bucket(cwd), { recursive: true })
    const timestamp = new Date(Date.UTC(2026, 8, 11, 0, 0, index)).toISOString()
    const path = join(bucket(cwd), id + '.jsonl')
    const body = Array.from(
      { length: paragraphs },
      (_, i) =>
        `### ${title} 节 ${i + 1}\n\n${'这一段讨论具体实现细节。'.repeat(30)}\n\n\`\`\`ts\nconst x${i} = ${i}\n\`\`\`\n`
    ).join('\n')
    const entries = [
      { type: 'session', version: 3, id, timestamp, cwd },
      {
        type: 'model_change',
        id: 'model',
        parentId: null,
        timestamp,
        provider: 'navigation-faux',
        modelId: 'fixture'
      },
      {
        type: 'thinking_level_change',
        id: 'thinking',
        parentId: 'model',
        thinkingLevel: 'off',
        timestamp
      },
      {
        type: 'message',
        id: 'u',
        parentId: 'thinking',
        timestamp,
        message: { role: 'user', content: `${title} 的原始问题`, timestamp: Date.parse(timestamp) }
      },
      {
        type: 'message',
        id: 'a',
        parentId: 'u',
        timestamp,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `${title} 的回答。\n\n${body}` }],
          api: 'openai-completions',
          provider: 'navigation-faux',
          model: 'fixture',
          stopReason: 'stop',
          timestamp: Date.parse(timestamp) + 1,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          }
        }
      },
      { type: 'session_info', id: 'name', parentId: 'a', timestamp, name: title }
    ]
    await writeFile(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
    return path
  }

  await seed(a, 'a-main', '甲会话很长内容多', 10, 40)
  await seed(a, 'a-older', '甲旧会话', 5, 40)
  await seed(b, 'b-exact', '乙会话短', 10, 2)

  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        'navigation-faux': {
          baseUrl: 'http://127.0.0.1:1/v1',
          api: 'openai-completions',
          models: [
            {
              id: 'fixture',
              name: 'Fixture',
              reasoning: false,
              input: ['text'],
              contextWindow: 8192,
              maxTokens: 1024,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
            }
          ]
        }
      }
    })
  )
  await writeFile(
    join(agentDir, 'auth.json'),
    JSON.stringify({ 'navigation-faux': { type: 'api_key', key: 'offline-fixture-only' } })
  )
  await writeFile(
    join(root, 'user-data', 'pi-desktop-preferences.json'),
    JSON.stringify({ lastProjectPath: a, recentProjects: [a, b] })
  )

  app = await electron.launch({
    args: [resolve('.')],
    cwd: a,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: join(root, 'home'),
      LANG: 'en_US.UTF-8',
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      PI_DESKTOP_E2E: '1',
      PI_DESKTOP_E2E_AGENT_DIR: agentDir,
      PI_DESKTOP_E2E_USER_DATA: join(root, 'user-data')
    }
  })
  const page = await app.firstWindow()
  await page.waitForFunction(
    async () => (await window.pi.getState()).sessionId === 'a-main',
    null,
    { timeout: 30000 }
  )
  await page.locator('.project-session-row').first().waitFor()

  // Instrument: log renderer events + DOM transitions relative to window.__t0 (set right before click)
  await page.evaluate(() => {
    window.__log = []
    window.__mark = (label) => window.__log.push({ t: Math.round(performance.now()), label })
    // contextBridge API is immutable; observe events without replacing send.
    const unsubscribe = window.pi.onEvent((event) => {
      if (event.event === 'snapshot')
        window.__mark(
          `event:snapshot g=${event.data.generation} rev=${event.data.revision} nodes=${event.data.nodes.length} session=${event.data.sessionId} ready=${event.data.ready} busy=${event.data.busy}`
        )
      if (event.event === 'patch')
        window.__mark(
          `event:patch g=${event.data.generation} rev=${event.data.revision} upserts=${event.data.nodeUpserts?.length ?? 0} removes=${event.data.removedNodeIds?.length ?? 0}`
        )
    })
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'attributes') {
          window.__mark(
            `DOM: ${m.attributeName}=${m.target.getAttribute(m.attributeName)} class=${m.target.className}`
          )
        }
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue
          if (n.classList?.contains('hero-copy')) window.__mark('DOM: hero-copy ADDED')
          if (n.classList?.contains('node-flow'))
            window.__mark(`DOM: node-flow ADDED children=${n.children.length}`)
          if (n.classList?.contains('catalog-disabled-reason'))
            window.__mark('DOM: sidebar reason ADDED')
          if (n.classList?.contains('client-error'))
            window.__mark('DOM: client-error ADDED ' + (n.textContent ?? '').slice(0, 80))
        }
        for (const n of m.removedNodes) {
          if (n.nodeType !== 1) continue
          if (n.classList?.contains('hero-copy')) window.__mark('DOM: hero-copy REMOVED')
          if (n.classList?.contains('node-flow'))
            window.__mark('DOM: node-flow REMOVED children=' + n.children.length)
          if (n.classList?.contains('catalog-disabled-reason'))
            window.__mark('DOM: sidebar reason REMOVED')
        }
      }
    })
    mo.observe(document.querySelector('.conversation') ?? document.body, {
      childList: true,
      subtree: true
    })
    mo.observe(document.querySelector('.sidebar') ?? document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'aria-busy', 'data-navigation-pending']
    })
    let frame, previous
    const measure = () => {
      const scope = document.querySelector('.catalog-scope')
      const groups = document.querySelector('.project-groups')
      const row = document.querySelector('.project-session-row')
      const sample = JSON.stringify({
        scopeHeight: scope?.getBoundingClientRect().height,
        groupsTop: groups?.getBoundingClientRect().top,
        rowOpacity: row ? getComputedStyle(row).opacity : null,
        rowDisabled: row?.disabled
      })
      if (sample !== previous) window.__mark(`VISUAL: ${sample}`)
      previous = sample
      frame = requestAnimationFrame(measure)
    }
    measure()
    window.__stopDiagnostic = () => {
      cancelAnimationFrame(frame)
      mo.disconnect()
      unsubscribe()
    }
  })

  const rowA = () => page.locator('.project-session-row', { hasText: '甲会话很长内容多' }).first()
  const rowB = () => page.locator('.project-session-row', { hasText: '乙会话短' }).first()

  // Switch to B
  await page.evaluate(() => {
    window.__t0 = performance.now()
    window.__mark('CLICK B')
  })
  await rowB().click()
  await page.waitForFunction(async () => (await window.pi.getState()).sessionId === 'b-exact')
  await page.waitForFunction(
    () => document.querySelector('.project-session-list')?.getAttribute('aria-busy') !== 'true'
  )
  // Switch back to A
  await page.evaluate(() => window.__mark('CLICK A'))
  await rowA().click()
  await page.waitForFunction(async () => (await window.pi.getState()).sessionId === 'a-main')
  await page.waitForFunction(
    () => document.querySelector('.project-session-list')?.getAttribute('aria-busy') !== 'true'
  )
  await page.evaluate(() => window.__stopDiagnostic())

  const log = await page.evaluate(() => window.__log)
  const t0 = log.find((l) => l.label === 'CLICK B').t
  console.log('--- timeline (ms relative to CLICK B) ---')
  for (const l of log) console.log(String(l.t - t0).padStart(6), l.label)
} finally {
  try {
    await app?.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

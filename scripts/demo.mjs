// Offline demo: the real app with fake accounts and local models, for trying the UI without
// real ChatGPT or Claude logins. Run with `npm run demo` (`-- --reset` starts over).
//
// - Pi: two ChatGPT subscription accounts (fake tokens, emails only) and a local 演示模型 that
//   answers every prompt. ChatGPT models are listed but cannot answer offline.
// - Claude Code: two subscription accounts (fake, emails only) and a 演示网关 API connection
//   that answers from a local server, so Claude Code chats work offline.
// - A small Git project with uncommitted changes for the Git tab, on desktop and in the phone
//   preview (Settings › 手机 › 打开预览).
//
// Everything lives in a private folder under the system temp directory, never in ~/.pi.
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const root = join(realpathSync(tmpdir()), 'pi-desktop-demo')
const agent = join(root, 'agent')
const userData = join(root, 'user-data')
const project = join(root, 'demo-shop')
const claudeConfig = join(userData, 'runtimes', 'claude', 'config')

const jwt = (email, plan) =>
  [
    'e30',
    Buffer.from(
      JSON.stringify({
        'https://api.openai.com/profile': { email },
        'https://api.openai.com/auth': { chatgpt_plan_type: plan, chatgpt_account_id: email }
      })
    ).toString('base64url'),
    'demo'
  ].join('.')
const codex = (email, plan) => ({
  type: 'oauth',
  access: jwt(email, plan),
  refresh: 'demo',
  expires: Date.now() + 365 * 864e5,
  accountId: email
})

async function seed() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true, mode: 0o700 })
  await Promise.all([
    mkdir(join(agent, 'extensions'), { recursive: true }),
    mkdir(claudeConfig, { recursive: true }),
    mkdir(join(project, 'src'), { recursive: true })
  ])

  await writeFile(
    join(agent, 'auth.json'),
    JSON.stringify(
      {
        demo: { type: 'api_key', key: 'offline-demo' },
        'openai-codex': codex('robin@example.com', 'plus'),
        'openai-codex-demo01': codex('robin@company.com', 'team')
      },
      null,
      2
    ),
    { mode: 0o600 }
  )
  await writeFile(
    join(agent, 'pi-multi-login.json'),
    JSON.stringify({ aliases: [{ base: 'openai-codex', suffix: 'demo01' }] })
  )
  await writeFile(
    join(agent, 'settings.json'),
    JSON.stringify({ defaultProvider: 'demo', defaultModel: 'demo-model' })
  )
  const ai = join(repo, 'node_modules/@earendil-works/pi-ai')
  const pkg = JSON.parse(await readFile(join(ai, 'package.json'), 'utf8'))
  await writeFile(
    join(agent, 'extensions', 'demo.ts'),
    `import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(resolve(ai, pkg.exports['.'].import))};
const lastPrompt = (context) => {
  const user = [...context.messages].reverse().find((message) => message.role === 'user');
  const content = user?.content;
  if (typeof content === 'string') return content;
  return (content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join(' ');
};
const reply = (context) =>
  fauxAssistantMessage(
    '这是离线演示模型的回复。\\n\\n你刚才说：「' + lastPrompt(context).slice(0, 200) + '」\\n\\n' +
    '- 可以在「设置 › 引擎与账号」里看订阅账号和 API 连接\\n' +
    '- 右侧工作台的 Git 标签页有几处未提交的改动\\n' +
    '- 「设置 › 手机 › 打开预览」能在电脑上试手机端'
  );
export default function (pi) {
  const faux = fauxProvider({
    provider: 'demo',
    api: 'demo',
    models: [{ id: 'demo-model', name: '演示模型', reasoning: false, contextWindow: 128000 }],
    tokensPerSecond: 120
  });
  faux.setResponses(Array.from({ length: 2000 }, () => reply));
  pi.registerProvider(faux.provider);
}
`
  )

  // Claude Code: listed accounts are fake (emails only); the API connection is served locally.
  await writeFile(
    join(claudeConfig, 'desktop.json'),
    JSON.stringify(
      {
        accounts: [
          { id: 'claude-demo0001', email: 'work@demo.dev', plan: 'Max' },
          { id: 'claude-demo0002', email: 'side@demo.dev', plan: 'Pro' }
        ],
        apis: [
          {
            id: 'claude-api-demo0001',
            label: '演示网关',
            apiKey: 'offline-demo',
            baseUrl: 'http://127.0.0.1:0'
          }
        ],
        active: 'claude-api-demo0001'
      },
      null,
      2
    ),
    { mode: 0o600 }
  )

  await writeFile(
    join(project, 'README.md'),
    '# Demo Shop\n\nA tiny project for trying Pi Desktop offline.\n'
  )
  await writeFile(
    join(project, 'src', 'cart.ts'),
    'export function total(prices: number[]): number {\n  return prices.reduce((sum, price) => sum + price, 0)\n}\n'
  )
  const git = (...command) =>
    execFileSync('git', command, {
      cwd: project,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Demo',
        GIT_AUTHOR_EMAIL: 'demo@example.com',
        GIT_COMMITTER_NAME: 'Demo',
        GIT_COMMITTER_EMAIL: 'demo@example.com'
      }
    })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'Initial demo shop')
  await writeFile(
    join(project, 'src', 'cart.ts'),
    'export function total(prices: number[], discount = 0): number {\n  const sum = prices.reduce((sum, price) => sum + price, 0)\n  return Math.max(0, sum - discount)\n}\n'
  )
  await writeFile(join(project, 'src', 'coupon.ts'), "export const WELCOME = 'WELCOME10'\n")
  await writeFile(join(root, '.seeded'), new Date().toISOString())
}

/** The API connection's address changes every run; point it at this run's server. */
async function pointClaudeAt(baseUrl) {
  const path = join(claudeConfig, 'desktop.json')
  const config = JSON.parse(await readFile(path, 'utf8'))
  for (const api of config.apis ?? []) if (api.id === 'claude-api-demo0001') api.baseUrl = baseUrl
  await writeFile(path, JSON.stringify(config, null, 2), { mode: 0o600 })
}

if (args.has('--reset') || !existsSync(join(root, '.seeded'))) await seed()
if (!args.has('--no-build')) execFileSync('npm', ['run', 'build'], { cwd: repo, stdio: 'inherit' })

const { createClaudeHttpFixture } = await import(join(repo, 'src', 'claude-host', 'sdk-fixture.ts'))
const fixture = await createClaudeHttpFixture({ cwd: project, streamDelayMs: 15 })
await pointClaudeAt(fixture.baseUrl)

const electron = createRequire(import.meta.url)('electron')
console.log(`\n离线演示数据在 ${root}\n演示项目：${project}\n`)
const child = spawn(electron, [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), repo], {
  stdio: 'inherit',
  env: {
    ...process.env,
    // The isolated-data mode only accepts folders inside a private temp root.
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    PI_DESKTOP_E2E: '1',
    PI_DESKTOP_DEMO: '1',
    PI_DESKTOP_E2E_AGENT_DIR: agent,
    PI_DESKTOP_E2E_USER_DATA: userData,
    PI_DESKTOP_DEMO_PROJECT: project
  }
})
const stop = () => child.kill()
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
child.on('exit', async (code) => {
  await fixture.close()
  process.exit(code ?? 0)
})

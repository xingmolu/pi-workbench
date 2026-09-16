import {
  MOBILE_KEEP_AWAKE_COPY,
  MOBILE_SECURITY_COPY
} from '../shared/mobile-gateway'

export function mobileManifest(): string {
  return JSON.stringify({
    name: 'Pi Desktop',
    short_name: 'Pi',
    display: 'standalone',
    start_url: '/',
    background_color: '#0a0a0a',
    theme_color: '#0a0a0a',
    lang: 'zh-CN'
  })
}

export function mobilePageHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
  <meta name="apple-mobile-web-app-capable" content="yes"/>
  <meta name="theme-color" content="#0a0a0a"/>
  <link rel="manifest" href="/manifest.webmanifest"/>
  <title>Pi Desktop</title>
  <style>
    :root { color-scheme: dark; --bg:#0a0a0a; --raised:#121212; --composer:#1e1e1e; --line:#2a2a2a; --text:#ecebea; --muted:#8b8b8b; --accent:#4d6fff; --danger:#c45c5c; --ok:#3d9a64; }
    * { box-sizing: border-box; }
    html, body { margin:0; min-height:100%; background:var(--bg); color:var(--text); font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { padding: env(safe-area-inset-top) 0 env(safe-area-inset-bottom); }
    header { position: sticky; top: 0; z-index: 2; display:flex; align-items:center; gap:10px; padding:12px 16px; background:var(--raised); border-bottom:1px solid var(--line); }
    header h1 { font-size:16px; margin:0; font-weight:600; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    button, textarea { font: inherit; color: inherit; }
    button { background: var(--composer); border:1px solid var(--line); border-radius:8px; padding:8px 12px; }
    button.primary { background: var(--accent); border-color: transparent; color:#fff; }
    button.danger { color: var(--danger); }
    button:disabled { opacity:.5; }
    .hint { color: var(--muted); font-size:12px; line-height:1.6; padding: 0 16px; }
    .warn { margin:12px 16px; padding:12px; border:1px solid #786235; background:#282316; border-radius:10px; color:#e5c782; font-size:13px; }
    .list { margin:0; padding:8px; }
    .list button.row { width:100%; text-align:left; margin:0 0 8px; padding:12px; display:flex; flex-direction:column; gap:4px; }
    .row small { color: var(--muted); }
    .dot { width:8px; height:8px; border-radius:50%; display:inline-block; margin-right:6px; background:#555; }
    .dot.running { background:#4d6fff; }
    .dot.awaiting-approval { background:#d7a441; }
    .dot.error { background: var(--danger); }
    main { padding-bottom: 140px; }
    .node { padding: 10px 16px; }
    .user { display:flex; justify-content:flex-end; }
    .user p { max-width: 86%; background:#2a2a2a; border-radius:16px; padding:10px 14px; margin:0; white-space:pre-wrap; }
    .assistant, .think, .tool, .error, .stopped, .model { white-space: pre-wrap; }
    .think, .model, .tool { color: var(--muted); font-size:13px; }
    .approval { margin:12px 16px; padding:12px; border:1px solid #786235; background:#282316; border-radius:10px; }
    .approval .actions { display:flex; gap:8px; margin-top:10px; }
    .composer { position:fixed; left:0; right:0; bottom:0; padding:10px 12px calc(10px + env(safe-area-inset-bottom)); background:var(--raised); border-top:1px solid var(--line); }
    .composer textarea { width:100%; min-height:56px; max-height:120px; resize:none; background:var(--composer); border:1px solid var(--line); border-radius:12px; padding:10px; }
    .composer .bar { display:flex; justify-content:space-between; align-items:center; gap:8px; margin-top:8px; }
    .queue { font-size:12px; color:var(--muted); }
    .empty { padding:48px 24px; text-align:center; color:var(--muted); }
  </style>
</head>
<body>
  <div id="app"></div>
  <script>
${mobileClientScript()}
  </script>
</body>
</html>`
}

function mobileClientScript(): string {
  return `const TOKEN_KEY = 'pi-desktop-device-token';
const SECURITY = ${JSON.stringify(MOBILE_SECURITY_COPY)};
const AWAKE = ${JSON.stringify(MOBILE_KEEP_AWAKE_COPY)};
const app = document.getElementById('app');
let token = localStorage.getItem(TOKEN_KEY) || '';
let route = location.hash.slice(1) || '/';
let live = [];
let catalog = [];
let snapshot = null;
let events = null;
let error = '';

function persistToken(value) {
  token = value;
  if (!value) {
    localStorage.removeItem(TOKEN_KEY);
    document.cookie = 'pi_device=; Path=/; Max-Age=0; SameSite=Lax';
    return;
  }
  localStorage.setItem(TOKEN_KEY, value);
  document.cookie = 'pi_device=' + encodeURIComponent(value) + '; Path=/; SameSite=Lax';
}
if (token) persistToken(token);

function esc(value) {
  return String(value ?? '').replace(/[&<>"]/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
}
async function api(path, options = {}) {
  const headers = Object.assign({ 'content-type': 'application/json' }, options.headers || {});
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(path, Object.assign({}, options, { headers }));
  if (res.status === 401) {
    persistToken('');
    throw new Error('尚未配对或设备已被撤销');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('请求失败 ' + res.status));
  return data;
}
function go(path) {
  route = path;
  if (location.hash.slice(1) !== path) location.hash = path;
  render();
}
window.addEventListener('hashchange', () => {
  route = location.hash.slice(1) || '/';
  render();
  if (route.startsWith('/s/')) watch(route.slice(3));
  else if (events) { events.close(); events = null; }
});

async function pairIfNeeded() {
  const params = new URLSearchParams(location.search);
  const pair = params.get('pair');
  if (!pair) return;
  const res = await fetch('/api/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: pair, deviceName: navigator.userAgent.slice(0, 64) || '手机' })
  });
  const grant = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(grant.error || '配对失败');
  persistToken(grant.deviceToken);
  history.replaceState({}, '', '/' + location.hash);
}

async function loadList() {
  const data = await api('/api/sessions');
  live = data.live || [];
  catalog = data.catalog || [];
}

async function openSession(cwd, sessionPath) {
  const data = await api('/api/sessions/open', {
    method: 'POST',
    body: JSON.stringify({ cwd, sessionPath })
  });
  go('/s/' + data.workerId);
  snapshot = data;
  watch(data.workerId);
}

function watch(workerId) {
  if (events) events.close();
  events = new EventSource('/api/sessions/' + encodeURIComponent(workerId) + '/events');
  events.addEventListener('snapshot', (event) => {
    snapshot = JSON.parse(event.data);
    render();
  });
  events.addEventListener('run-finished', () => {
    if (navigator.vibrate) navigator.vibrate(40);
  });
  events.onerror = () => {};
}

async function send(text) {
  if (!snapshot || !snapshot.sessionId) throw new Error('会话尚未就绪');
  await api('/api/sessions/' + encodeURIComponent(snapshot.workerId) + '/send', {
    method: 'POST',
    body: JSON.stringify({ text, sessionId: snapshot.sessionId, generation: snapshot.generation })
  });
}
async function abort() {
  await api('/api/sessions/' + encodeURIComponent(snapshot.workerId) + '/abort', { method: 'POST', body: '{}' });
}
async function clearQueue() {
  await api('/api/sessions/' + encodeURIComponent(snapshot.workerId) + '/queue/clear', { method: 'POST', body: '{}' });
}
async function respond(approvalId, allow) {
  await api('/api/sessions/' + encodeURIComponent(snapshot.workerId) + '/approval', {
    method: 'POST',
    body: JSON.stringify({ approvalId, allow })
  });
}

function nodeHtml(node) {
  if (node.type === 'user') return '<div class="node user"><p>' + esc(node.text) + '</p></div>';
  if (node.type === 'assistant') return '<div class="node assistant">' + esc(node.markdown) + '</div>';
  if (node.type === 'think') return '<div class="node think">思考 · ' + esc((node.text || '').slice(0, 400)) + '</div>';
  if (node.type === 'tool') return '<div class="node tool">工具 · ' + esc(node.title || node.name) + ' · ' + esc(node.status) + '</div>';
  if (node.type === 'error') return '<div class="node error">' + esc(node.message) + '</div>';
  if (node.type === 'stopped') return '<div class="node stopped">' + esc(node.message) + '</div>';
  if (node.type === 'model') return '<div class="node model">' + (node.initial ? '模型' : '模型切换') + ' · ' + esc(node.name || node.modelId) + '</div>';
  if (node.type === 'compaction') return '<div class="node model">上下文已压缩，历史消息仍保留</div>';
  return '';
}

function renderList() {
  const rows = live.map((item) =>
    '<li><button class="row" data-open="' + esc(item.workerId) + '"><span><span class="dot ' + esc(item.status) + '"></span>' +
    esc(item.title) + '</span><small>' + esc(item.cwd) + ' · ' + esc(item.status) + '</small></button></li>'
  ).join('');
  const history = catalog.map((project) =>
    '<h2 class="hint">' + esc(project.name) + '</h2>' +
    project.sessions.map((session) =>
      '<button class="row" data-cwd="' + esc(project.path) + '" data-path="' + esc(session.path) + '">' +
      esc(session.title) + '<small>' + esc(session.modified) + '</small></button>'
    ).join('')
  ).join('');
  app.innerHTML =
    '<header><h1>Pi Desktop</h1></header>' +
    '<p class="warn">' + esc(SECURITY) + '</p>' +
    '<p class="hint">' + esc(AWAKE) + '</p>' +
    (error ? '<p class="warn">' + esc(error) + '</p>' : '') +
    '<ul class="list">' + (rows || '<li class="empty">当前没有已打开的会话。从下面继续历史会话。</li>') + '</ul>' +
    history;
  app.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', async () => {
    snapshot = await api('/api/sessions/' + encodeURIComponent(el.getAttribute('data-open')));
    go('/s/' + snapshot.workerId);
    watch(snapshot.workerId);
  }));
  app.querySelectorAll('[data-cwd]').forEach((el) => el.addEventListener('click', () => {
    openSession(el.getAttribute('data-cwd'), el.getAttribute('data-path')).catch((err) => { error = err.message; render(); });
  }));
}

function renderChat() {
  if (!snapshot) {
    app.innerHTML = '<header><button id="back">返回</button><h1>会话</h1></header><p class="empty">正在读取…</p>';
    document.getElementById('back').onclick = () => go('/');
    return;
  }
  const busy = snapshot.busy;
  const sendLabel = busy ? 'Queue' : '发送';
  const approvals = (snapshot.approvals || []).map((item) =>
    '<div class="approval"><strong>等待批准</strong><div>' + esc(item.title) + '</div><small>' + esc(item.detail || item.toolName) +
    '</small><div class="actions"><button data-allow="' + esc(item.id) + '">允许</button><button class="danger" data-deny="' + esc(item.id) + '">拒绝</button></div></div>'
  ).join('');
  app.innerHTML =
    '<header><button id="back">返回</button><h1>' + esc(snapshot.title) + '</h1></header>' +
    '<main>' + (snapshot.nodes || []).map(nodeHtml).join('') + approvals + '</main>' +
    '<form class="composer"><textarea id="draft" placeholder="继续对话"></textarea><div class="bar">' +
    '<span class="queue">' + (snapshot.queuedCount ? ('队列 ' + snapshot.queuedCount) : (busy ? '运行中' : '')) + '</span>' +
    '<span>' + (snapshot.queuedCount ? '<button type="button" id="clear">清空队列</button>' : '') +
    (busy ? '<button type="button" id="stop">Stop</button>' : '') +
    '<button class="primary" id="send">' + sendLabel + '</button></span></div></form>';
  document.getElementById('back').onclick = () => go('/');
  const draft = document.getElementById('draft');
  document.getElementById('send').onclick = async (event) => {
    event.preventDefault();
    try { await send(draft.value); draft.value = ''; } catch (err) { error = err.message; render(); }
  };
  const stop = document.getElementById('stop');
  if (stop) stop.onclick = () => abort().catch((err) => { error = err.message; render(); });
  const clear = document.getElementById('clear');
  if (clear) clear.onclick = () => clearQueue().catch((err) => { error = err.message; render(); });
  app.querySelectorAll('[data-allow]').forEach((el) => el.onclick = () => respond(el.getAttribute('data-allow'), true));
  app.querySelectorAll('[data-deny]').forEach((el) => el.onclick = () => respond(el.getAttribute('data-deny'), false));
}

function renderAuth() {
  app.innerHTML = '<header><h1>Pi Desktop</h1></header><p class="warn">' + esc(SECURITY) +
    '</p><p class="empty">请在桌面设置中显示局域网二维码，用这台手机扫描完成配对。</p>' +
    (error ? '<p class="warn">' + esc(error) + '</p>' : '');
}

function render() {
  if (!token) return renderAuth();
  if (route.startsWith('/s/')) return renderChat();
  renderList();
}

(async function boot() {
  try {
    await pairIfNeeded();
    if (token) await loadList();
    if (route.startsWith('/s/')) {
      snapshot = await api('/api/sessions/' + encodeURIComponent(route.slice(3)));
      watch(route.slice(3));
    }
  } catch (err) {
    error = err.message;
  }
  render();
})();`
}

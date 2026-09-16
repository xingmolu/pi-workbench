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
    :root {
      color-scheme: dark;
      --bg: #0a0a0a;
      --raised: #111111;
      --composer: #1a1a1a;
      --line: #262626;
      --text: #ecebea;
      --muted: #8a8a8a;
      --accent: #4d6fff;
      --danger: #c45c5c;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--text); font: 15px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { padding: env(safe-area-inset-top) 0 0; }
    header.top {
      position: sticky; top: 0; z-index: 3;
      display: flex; align-items: center; gap: 8px;
      min-height: 44px; padding: 0 12px;
      background: color-mix(in srgb, var(--bg) 92%, transparent);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--line);
    }
    header.top h1 { font-size: 16px; margin: 0; font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    header.top .host { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 46%; }
    header.top .icon-btn, .icon-btn {
      width: 36px; height: 36px; padding: 0; border: 0; background: transparent; color: var(--text);
      border-radius: 8px; flex-shrink: 0;
    }
    button, textarea, input { font: inherit; color: inherit; }
    button { background: var(--composer); border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; }
    button.primary { background: var(--accent); border-color: transparent; color: #fff; }
    button.danger { color: var(--danger); background: transparent; }
    button:disabled { opacity: .5; }
    .notice {
      display: flex; align-items: center; gap: 8px;
      margin: 8px 12px 0; padding: 8px 10px;
      border: 1px solid color-mix(in srgb, #786235 70%, var(--line));
      background: #1c1810; border-radius: 8px; color: #d7c394; font-size: 12px; line-height: 1.35;
    }
    .notice p { margin: 0; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .notice .icon-btn { width: 32px; height: 32px; color: inherit; }
    .home { padding-bottom: calc(64px + env(safe-area-inset-bottom)); }
    .group-label {
      position: sticky; top: 44px; z-index: 1;
      margin: 0; padding: 14px 16px 6px;
      font-size: 12px; font-weight: 600; color: var(--muted);
      background: var(--bg);
    }
    .session-row {
      width: 100%; min-height: 44px; margin: 0; padding: 8px 16px 8px 28px;
      display: flex; align-items: center; gap: 10px;
      text-align: left; background: transparent; border: 0; border-radius: 0;
    }
    .session-row:active { background: rgb(255 255 255 / 6%); }
    .session-row .title {
      flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-size: 15px; font-weight: 450;
    }
    .session-row .when {
      flex-shrink: 0; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums;
    }
    .dot {
      width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: transparent;
    }
    .dot.running { background: #4d6fff; box-shadow: 0 0 0 3px rgb(77 111 255 / 18%); }
    .dot.awaiting-approval { background: #d7a441; }
    .dot.error { background: var(--danger); }
    .dot.opening { background: #4d6fff; animation: pulse 1s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: .35; } }
    .search {
      position: fixed; left: 0; right: 0; bottom: 0; z-index: 3;
      padding: 8px 12px calc(8px + env(safe-area-inset-bottom));
      background: var(--raised); border-top: 1px solid var(--line);
    }
    .search input {
      width: 100%; height: 40px; padding: 0 12px; border-radius: 10px;
      border: 1px solid var(--line); background: var(--composer);
    }
    .empty { padding: 36px 24px; text-align: center; color: var(--muted); font-size: 13px; }
    main.chat { padding: 8px 0 calc(128px + env(safe-area-inset-bottom)); }
    .node { padding: 6px 16px; font-size: 15px; }
    .user { display: flex; justify-content: flex-end; }
    .user p { max-width: 86%; background: #2a2a2a; border-radius: 14px; padding: 8px 12px; margin: 0; white-space: pre-wrap; }
    .assistant { white-space: pre-wrap; padding: 4px 16px 10px; }
    .think, .tool, .model {
      color: var(--muted); font-size: 12px; padding: 3px 16px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .error, .stopped { color: var(--danger); font-size: 13px; white-space: pre-wrap; }
    .approval { margin: 8px 16px; padding: 10px 12px; border: 1px solid #786235; background: #1c1810; border-radius: 10px; font-size: 13px; }
    .approval .actions { display: flex; gap: 8px; margin-top: 8px; }
    .composer {
      position: fixed; left: 0; right: 0; bottom: 0;
      padding: 8px 12px calc(8px + env(safe-area-inset-bottom));
      background: var(--raised); border-top: 1px solid var(--line);
    }
    .composer textarea {
      width: 100%; min-height: 44px; max-height: 100px; resize: none;
      background: var(--composer); border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px;
    }
    .composer .bar { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 6px; }
    .queue { font-size: 12px; color: var(--muted); }
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
const NOTICE_KEY = 'pi-mobile-notice';
const SECURITY = ${JSON.stringify(MOBILE_SECURITY_COPY)};
const AWAKE = ${JSON.stringify(MOBILE_KEEP_AWAKE_COPY)};
const app = document.getElementById('app');
let token = localStorage.getItem(TOKEN_KEY) || '';
let route = location.hash.slice(1) || '/';
let groups = [];
let snapshot = null;
let events = null;
let error = '';
let hostName = location.hostname;
let query = '';
let searchFocused = false;

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
function hostLabel(value) {
  return String(value || '').trim() || '本机';
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
  hostName = data.host || hostName;
  groups = data.groups || [];
}

async function openSession(cwd, sessionPath, workerId) {
  if (workerId) {
    snapshot = await api('/api/sessions/' + encodeURIComponent(workerId));
    go('/s/' + snapshot.workerId);
    watch(snapshot.workerId);
    return;
  }
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

function toolLine(node) {
  const status = {
    queued: '已排队',
    'awaiting-approval': '等待批准',
    running: '正在运行',
    success: '已运行',
    error: '失败',
    blocked: '已阻止',
    incomplete: '未完成',
    'waiting-resource': '等待资源'
  }[node.status] || '工具';
  return status + ' · ' + (node.title || node.name || '工具');
}

function nodeHtml(node) {
  if (node.type === 'user') return '<div class="node user"><p>' + esc(node.text) + '</p></div>';
  if (node.type === 'assistant') return '<div class="assistant">' + esc(node.markdown) + '</div>';
  if (node.type === 'think') return '<div class="think">' + (node.streaming ? '正在思考' : '思考 · ' + esc((node.text || '').replace(/\\s+/g, ' ').slice(0, 80))) + '</div>';
  if (node.type === 'tool') return '<div class="tool">' + esc(toolLine(node)) + '</div>';
  if (node.type === 'error') return '<div class="node error">' + esc(node.message) + '</div>';
  if (node.type === 'stopped') return '<div class="node stopped">' + esc(node.message) + '</div>';
  if (node.type === 'model') return '<div class="model">' + (node.initial ? '模型' : '模型切换') + ' · ' + esc(node.name || node.modelId) + '</div>';
  if (node.type === 'compaction') return '<div class="model">上下文已压缩</div>';
  return '';
}

function noticeHtml() {
  if (localStorage.getItem(NOTICE_KEY) === '1') return '';
  return '<div class="notice"><p title="' + esc(SECURITY + ' ' + AWAKE) + '">仅扫自己的码 · 远程时请保持 Mac 唤醒</p>' +
    '<button type="button" class="icon-btn" id="dismiss-notice" aria-label="关闭提示">×</button></div>';
}

function filteredGroups() {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return groups;
  return groups.map((group) => ({
    ...group,
    sessions: group.sessions.filter((session) =>
      (session.title || '').toLocaleLowerCase().includes(needle) ||
      (group.name || '').toLocaleLowerCase().includes(needle)
    )
  })).filter((group) => group.sessions.length);
}

function renderList() {
  const visible = filteredGroups();
  const body = visible.map((group) =>
    '<h2 class="group-label">' + esc(group.name) + '</h2>' +
    group.sessions.map((session) =>
      '<button type="button" class="session-row" data-cwd="' + esc(session.cwd) + '" data-path="' + esc(session.sessionPath || '') +
      '" data-worker="' + esc(session.workerId || '') + '"><span class="title">' + esc(session.title) +
      '</span><span class="when">' + esc(session.timeLabel || '') + '</span><span class="dot ' + esc(session.status) + '" aria-label="' + esc(session.status) + '"></span></button>'
    ).join('')
  ).join('');
  app.innerHTML =
    '<header class="top"><h1>对话</h1><span class="host">' + esc(hostLabel(hostName)) + '</span></header>' +
    '<div class="home">' +
    noticeHtml() +
    (error ? '<p class="notice" role="alert">' + esc(error) + '</p>' : '') +
    (body || '<p class="empty">没有匹配的会话</p>') +
    '</div>' +
    '<div class="search"><input id="filter" type="search" placeholder="搜索会话" value="' + esc(query) + '" enterkeyhint="search"/></div>';
  const dismiss = document.getElementById('dismiss-notice');
  if (dismiss) dismiss.onclick = () => { localStorage.setItem(NOTICE_KEY, '1'); render(); };
  app.querySelectorAll('.session-row').forEach((el) => el.addEventListener('click', () => {
    const workerId = el.getAttribute('data-worker');
    const cwd = el.getAttribute('data-cwd');
    const sessionPath = el.getAttribute('data-path') || undefined;
    openSession(cwd, sessionPath, workerId || undefined).catch((err) => { error = err.message; render(); });
  }));
  const filter = document.getElementById('filter');
  if (filter) {
    filter.addEventListener('input', () => { query = filter.value; searchFocused = true; renderList(); });
    filter.addEventListener('blur', () => { searchFocused = false; });
    if (searchFocused) {
      filter.focus();
      const end = filter.value.length;
      filter.setSelectionRange(end, end);
    }
  }
}

function renderChat() {
  if (!snapshot) {
    app.innerHTML = '<header class="top"><button class="icon-btn" id="back" aria-label="返回">‹</button><h1>会话</h1></header><p class="empty">正在读取…</p>';
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
    '<header class="top"><button class="icon-btn" id="back" aria-label="返回">‹</button><h1>' + esc(snapshot.title) +
    '</h1><span class="dot ' + esc(snapshot.status) + '"></span></header>' +
    '<main class="chat">' + (snapshot.nodes || []).map(nodeHtml).join('') + approvals + '</main>' +
    '<form class="composer"><textarea id="draft" placeholder="继续对话"></textarea><div class="bar">' +
    '<span class="queue">' + (snapshot.queuedCount ? ('队列 ' + snapshot.queuedCount) : (busy ? '运行中' : '')) + '</span>' +
    '<span>' + (snapshot.queuedCount ? '<button type="button" id="clear">清空</button>' : '') +
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
  app.innerHTML = '<header class="top"><h1>Pi Desktop</h1></header>' +
    '<div class="notice"><p>' + esc(SECURITY) + '</p></div>' +
    '<p class="empty">请在桌面设置中显示局域网二维码，用这台手机扫描完成配对。</p>' +
    (error ? '<p class="notice" role="alert">' + esc(error) + '</p>' : '');
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

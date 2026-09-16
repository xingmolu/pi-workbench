import { MOBILE_KEEP_AWAKE_COPY, MOBILE_SECURITY_COPY } from '../shared/mobile-gateway'
import { renderMobileMarkdown } from '../shared/mobile-markdown'

export function mobileClientScript(): string {
  return `"use strict";
function __name(fn, _n) { return fn; }
const TOKEN_KEY = "pi-desktop-device-token";
const NOTICE_KEY = "pi-mobile-notice";
const THEME_KEY = "pi-mobile-theme";
const OPEN_KEY = "pi-mobile-open-projects";
const SECURITY = ${JSON.stringify(MOBILE_SECURITY_COPY)};
const AWAKE = ${JSON.stringify(MOBILE_KEEP_AWAKE_COPY)};
const renderMarkdown = ${renderMobileMarkdown.toString()};
const app = document.getElementById("app");
let token = localStorage.getItem(TOKEN_KEY) || "";
let route = location.hash.slice(1) || "/";
let groups = [];
let snapshot = null;
let events = null;
let error = "";
let hostName = location.hostname;
let query = "";
let searchOpen = false;
let searchFocused = false;
let themeMenu = false;
let draft = "";
let copiedId = "";
let copiedTimer = 0;
let pinBottom = true;
let listScroll = 0;

function applyTheme(value) {
  const next = value || localStorage.getItem(THEME_KEY) || "system";
  if (next === "light" || next === "dark") {
    document.documentElement.dataset.theme = next;
    localStorage.setItem(THEME_KEY, next);
  } else {
    delete document.documentElement.dataset.theme;
    localStorage.setItem(THEME_KEY, "system");
  }
  const dark = document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme && !window.matchMedia("(prefers-color-scheme: light)").matches);
  const meta = document.querySelector("meta[name=theme-color]");
  if (meta) meta.setAttribute("content", dark ? "#0b0b0c" : "#f3f3f5");
}
applyTheme();

function persistToken(value) {
  token = value;
  if (!value) {
    localStorage.removeItem(TOKEN_KEY);
    document.cookie = "pi_device=; Path=/; Max-Age=0; SameSite=Lax";
    return;
  }
  localStorage.setItem(TOKEN_KEY, value);
  document.cookie = "pi_device=" + encodeURIComponent(value) + "; Path=/; SameSite=Lax";
}
if (token) persistToken(token);

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, function (ch) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch];
  });
}
function hostLabel(value) {
  return String(value || "").trim() || "本机";
}
function icon(name) {
  const icons = {
    back: '<polyline points="15 18 9 12 15 6"/>',
    search: '<circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
    palette: '<path d="M12 3a9 9 0 1 0 0 18h1.5a2.5 2.5 0 0 0 0-5H12"/><circle cx="7.5" cy="10" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="14" cy="7.5" r="1"/><circle cx="16.5" cy="10.5" r="1"/>',
    folder: '<path d="M3 7h6l2 2h10v10H3z"/>',
    chevron: '<polyline points="9 18 15 12 9 6"/>',
    send: '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="1"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5h10"/>'
  };
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + (icons[name] || "") + "</svg>";
}
function badge(status) {
  const map = {
    running: { label: "运行中", kind: "run" },
    opening: { label: "运行中", kind: "run" },
    "awaiting-approval": { label: "等待批准", kind: "ask" },
    error: { label: "出错", kind: "err" },
    idle: { label: "已完成", kind: "ok" }
  };
  return map[status] || { label: "空闲", kind: "idle" };
}
function openSet() {
  try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || "[]")); }
  catch { return new Set(); }
}
function saveOpen(set) {
  localStorage.setItem(OPEN_KEY, JSON.stringify(Array.from(set)));
}
function isOpen(path, fallback) {
  const stored = localStorage.getItem(OPEN_KEY);
  if (stored == null) return fallback;
  return openSet().has(path);
}
function toggleOpen(path, fallback) {
  const set = storedOpenOrDefaults(fallback);
  if (set.has(path)) set.delete(path); else set.add(path);
  saveOpen(set);
}
function storedOpenOrDefaults(fallbackPaths) {
  if (localStorage.getItem(OPEN_KEY) == null) return new Set(fallbackPaths);
  return openSet();
}
async function api(path, options) {
  options = options || {};
  const headers = Object.assign({ "content-type": "application/json" }, options.headers || {});
  if (token) headers.authorization = "Bearer " + token;
  const res = await fetch(path, Object.assign({}, options, { headers }));
  if (res.status === 401) {
    persistToken("");
    throw new Error("尚未配对或设备已被撤销");
  }
  const data = await res.json().catch(function () { return {}; });
  if (!res.ok) throw new Error(data.error || ("请求失败 " + res.status));
  return data;
}
function go(path) {
  route = path;
  if (location.hash.slice(1) !== path) location.hash = path;
  render();
}
window.addEventListener("hashchange", function () {
  route = location.hash.slice(1) || "/";
  render();
  if (route.startsWith("/s/")) watch(route.slice(3));
  else if (events) { events.close(); events = null; }
});
window.addEventListener("keydown", function (event) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    searchOpen = true;
    searchFocused = true;
    if (route.startsWith("/s/") && window.matchMedia("(max-width: 899px)").matches) go("/");
    else render();
    const filter = document.getElementById("filter") || document.getElementById("filter-wide");
    if (filter) filter.focus();
  }
  if (event.key === "Escape") { themeMenu = false; render(); }
});

async function pairIfNeeded() {
  const params = new URLSearchParams(location.search);
  const pair = params.get("pair");
  if (!pair) return;
  const res = await fetch("/api/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: pair, deviceName: navigator.userAgent.slice(0, 64) || "手机" })
  });
  const grant = await res.json().catch(function () { return {}; });
  if (!res.ok) throw new Error(grant.error || "配对失败");
  persistToken(grant.deviceToken);
  history.replaceState({}, "", "/" + location.hash);
}

async function loadList() {
  const data = await api("/api/sessions");
  hostName = data.host || hostName;
  groups = data.groups || [];
}

async function openSession(cwd, sessionPath, workerId) {
  if (workerId) {
    snapshot = await api("/api/sessions/" + encodeURIComponent(workerId));
    go("/s/" + snapshot.workerId);
    watch(snapshot.workerId);
    return;
  }
  const data = await api("/api/sessions/open", {
    method: "POST",
    body: JSON.stringify({ cwd: cwd, sessionPath: sessionPath })
  });
  go("/s/" + data.workerId);
  snapshot = data;
  watch(data.workerId);
}

function watch(workerId) {
  if (events) events.close();
  events = new EventSource("/api/sessions/" + encodeURIComponent(workerId) + "/events");
  events.addEventListener("snapshot", function (event) {
    snapshot = JSON.parse(event.data);
    render();
  });
  events.addEventListener("run-finished", function () {
    if (navigator.vibrate) navigator.vibrate(40);
  });
  events.onerror = function () {};
}

async function send(text) {
  if (!snapshot || !snapshot.sessionId) throw new Error("会话尚未就绪");
  await api("/api/sessions/" + encodeURIComponent(snapshot.workerId) + "/send", {
    method: "POST",
    body: JSON.stringify({ text: text, sessionId: snapshot.sessionId, generation: snapshot.generation })
  });
}
async function abort() {
  await api("/api/sessions/" + encodeURIComponent(snapshot.workerId) + "/abort", { method: "POST", body: "{}" });
}
async function clearQueue() {
  await api("/api/sessions/" + encodeURIComponent(snapshot.workerId) + "/queue/clear", { method: "POST", body: "{}" });
}
async function respond(approvalId, allow) {
  await api("/api/sessions/" + encodeURIComponent(snapshot.workerId) + "/approval", {
    method: "POST",
    body: JSON.stringify({ approvalId: approvalId, allow: allow })
  });
}

function toolLine(node) {
  const status = {
    queued: "已排队",
    "awaiting-approval": "等待批准",
    running: "正在运行",
    success: "已运行",
    error: "失败",
    blocked: "已阻止",
    incomplete: "未完成",
    "waiting-resource": "等待资源"
  }[node.status] || "工具";
  return status + " · " + (node.title || node.name || "工具");
}

function copyText(id, text) {
  const done = function () {
    copiedId = id;
    render();
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(function () { copiedId = ""; render(); }, 1600);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(function () {
      error = "无法复制";
      render();
    });
    return;
  }
  done();
}

function sessionStamp() {
  if (!snapshot) return "";
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    for (let i = 0; i < group.sessions.length; i++) {
      const session = group.sessions[i];
      if (session.workerId === snapshot.workerId || (session.sessionPath && session.sessionPath === snapshot.sessionPath)) {
        return session.timeLabel || "";
      }
    }
  }
  return "";
}

function lastSpeakIndex(nodes) {
  let index = -1;
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].type === "user" || nodes[i].type === "assistant") index = i;
  }
  return index;
}

function nodeHtml(node, index, last) {
  if (node.type === "user") {
    return '<div class="node user"><p class="bubble">' + esc(node.text) + "</p></div>" +
      msgBar(node.id, node.text, last ? sessionStamp() : "");
  }
  if (node.type === "assistant") {
    return '<div class="assistant">' + renderMarkdown(node.markdown || "") + "</div>" +
      msgBar(node.id, node.markdown || "", last ? sessionStamp() : "");
  }
  if (node.type === "think") {
    return '<div class="think">' + (node.streaming ? "正在思考" : "思考 · " + esc(String(node.text || "").replace(/\\s+/g, " ").slice(0, 80))) + "</div>";
  }
  if (node.type === "tool") return '<div class="tool">' + esc(toolLine(node)) + "</div>";
  if (node.type === "error") return '<div class="node error">' + esc(node.message) + "</div>";
  if (node.type === "stopped") return '<div class="node stopped">' + esc(node.message) + "</div>";
  if (node.type === "model") return '<div class="model">' + (node.initial ? "模型" : "模型切换") + " · " + esc(node.name || node.modelId) + "</div>";
  if (node.type === "compaction") return '<div class="model">上下文已压缩</div>';
  return "";
}

function msgBar(id, text, stamp) {
  const copied = copiedId === id ? " is-copied" : "";
  const label = copiedId === id ? "已复制" : "复制";
  return '<div class="msg-bar"><button type="button" class="' + copied + '" data-copy-id="' + esc(id) +
    '" data-copy="' + encodeURIComponent(text) + '">' + icon("copy") + " " + label + "</button>" +
    (stamp ? "<time>" + esc(stamp) + "</time>" : "") + "</div>";
}

function noticeHtml() {
  if (localStorage.getItem(NOTICE_KEY) === "1") return "";
  return '<div class="notice"><p title="' + esc(SECURITY + " " + AWAKE) + '">仅扫自己的码 · 远程时请保持 Mac 唤醒</p>' +
    '<button type="button" class="icon-btn" id="dismiss-notice" aria-label="关闭提示">×</button></div>';
}

function filteredGroups() {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return groups;
  return groups.map(function (group) {
    return Object.assign({}, group, {
      sessions: group.sessions.filter(function (session) {
        return (session.title || "").toLocaleLowerCase().includes(needle) ||
          (group.name || "").toLocaleLowerCase().includes(needle);
      })
    });
  }).filter(function (group) { return group.sessions.length; });
}

function selectedKey() {
  if (!route.startsWith("/s/")) return "";
  return route.slice(3);
}

function defaultOpenPaths(visible) {
  const paths = [];
  visible.forEach(function (group, index) {
    const hot = group.sessions.some(function (session) {
      return session.status === "running" || session.status === "opening" || session.status === "awaiting-approval";
    });
    if (hot || index === 0) paths.push(group.path);
  });
  return paths;
}

function themeMenuHtml() {
  if (!themeMenu) return "";
  const current = localStorage.getItem(THEME_KEY) || "system";
  return '<div class="theme-menu" id="theme-menu">' +
    [["system", "系统默认"], ["dark", "深色主题"], ["light", "浅色主题"]].map(function (item) {
      return '<button type="button" data-theme="' + item[0] + '" class="' + (current === item[0] ? "is-on" : "") + '">' + item[1] + "</button>";
    }).join("") + "</div>";
}

function listPaneHtml() {
  const visible = filteredGroups();
  const defaults = defaultOpenPaths(visible);
  const selected = selectedKey();
  const total = visible.reduce(function (sum, group) { return sum + group.sessions.length; }, 0);
  const cards = visible.map(function (group) {
    const open = isOpen(group.path, defaults.indexOf(group.path) >= 0);
    const latest = group.sessions.map(function (item) { return item.timeLabel; }).filter(Boolean)[0] || "";
    const rows = group.sessions.map(function (session) {
      const mark = badge(session.status);
      const on = (session.workerId && session.workerId === selected) ? " is-on" : "";
      return '<button type="button" class="session-row' + on + '" data-cwd="' + esc(session.cwd) +
        '" data-path="' + esc(session.sessionPath || "") + '" data-worker="' + esc(session.workerId || "") +
        '"><span class="title">' + esc(session.title) + '</span><span class="when">' + esc(session.timeLabel || "") +
        '</span><span class="pill ' + mark.kind + '">' + esc(mark.label) + "</span></button>";
    }).join("");
    return '<article class="project' + (open ? " is-open" : "") + '">' +
      '<button type="button" class="project-head" data-toggle="' + esc(group.path) + '">' +
      '<span class="folder">' + icon("folder") + "</span>" +
      '<span class="meta"><span class="name"><span>' + esc(group.name) + '</span><span class="local">本机</span></span>' +
      '<span class="sub">' + esc(group.path) + (latest ? " · 更新于 " + esc(latest) : "") + "</span></span>" +
      '<span class="count">' + group.sessions.length + " 个会话</span>" +
      '<span class="chevron">' + icon("chevron") + "</span></button>" +
      '<div class="project-sessions">' + rows + "</div></article>";
  }).join("");
  return '<header class="top"><h1>远程对话</h1>' +
    '<button type="button" class="icon-btn list-search-btn" id="toggle-search" aria-label="搜索">' + icon("search") + "</button>" +
    '<button type="button" class="icon-btn" id="refresh" aria-label="刷新">' + icon("refresh") + "</button>" +
    '<button type="button" class="icon-btn" id="theme" aria-label="主题">' + icon("palette") + "</button>" +
    themeMenuHtml() + "</header>" +
    '<div class="connect"><span class="live-dot"></span>已连接到 ' + esc(hostLabel(hostName)) + "</div>" +
    noticeHtml() +
    (error ? '<p class="notice" role="alert">' + esc(error) + "</p>" : "") +
    '<div class="toolbar"><div class="label"><strong>当前设备上的项目和会话</strong><small>' +
    visible.length + " 个项目 · " + total + " 个会话</small></div></div>" +
    '<div class="search-box' + (searchOpen ? " is-on" : "") + '"><input id="filter" type="search" placeholder="搜索会话" value="' +
    esc(query) + '" enterkeyhint="search"/></div>' +
    '<div class="search-wide"><input id="filter-wide" type="search" placeholder="搜索会话  ⌘K" value="' + esc(query) + '"/></div>' +
    '<div class="list-scroll" id="list-scroll">' + (cards || '<p class="empty">没有匹配的会话</p>') + "</div>";
}

function chatPaneHtml() {
  if (!snapshot) {
    if (!route.startsWith("/s/")) {
      return '<header class="top"><h1>对话</h1><span class="host">' + esc(hostLabel(hostName)) + '</span></header>' +
        '<div class="wide-empty">从左侧选择一个会话，继续同一条桌面对话。</div>';
    }
    return '<header class="top"><button class="icon-btn back-btn" id="back" aria-label="返回">' + icon("back") +
      '</button><h1>会话</h1></header><p class="empty">正在读取…</p>';
  }
  const busy = snapshot.busy;
  const mark = badge(snapshot.status);
  const approvals = (snapshot.approvals || []).map(function (item) {
    return '<div class="approval"><strong>等待批准</strong><div>' + esc(item.title) + '</div><small>' +
      esc(item.detail || item.toolName) + '</small><div class="actions"><button data-allow="' + esc(item.id) +
      '">允许</button><button class="danger" data-deny="' + esc(item.id) + '">拒绝</button></div></div>';
  }).join("");
  const queue = snapshot.queuedCount ? ("队列 " + snapshot.queuedCount) : (busy ? "运行中 · 发送将排队" : "");
  return '<header class="top"><button class="icon-btn back-btn" id="back" aria-label="返回">' + icon("back") +
    '</button><h1>任务会话</h1>' +
    '<button type="button" class="icon-btn" id="copy-title" aria-label="复制标题" data-copy="' + encodeURIComponent(snapshot.title) +
    '" data-copy-id="title">' + icon("copy") + '</button>' +
    '<button type="button" class="icon-btn" id="theme-chat" aria-label="主题">' + icon("palette") + '</button>' +
    themeMenuHtml() + '</header>' +
    '<div class="subhead"><strong>' + esc(snapshot.title) + '</strong><span class="pill ' + mark.kind + '">' +
    esc(mark.label) + '</span></div>' +
    (error ? '<p class="notice" role="alert">' + esc(error) + '</p>' : '') +
    '<main class="chat-scroll" id="chat-scroll">' + (function () {
      const nodes = snapshot.nodes || [];
      const last = lastSpeakIndex(nodes);
      return nodes.map(function (node, index) { return nodeHtml(node, index, index === last); }).join("");
    })() + approvals + '</main>' +
    '<form class="composer" id="composer"><div class="composer-box">' +
    '<textarea id="draft" placeholder="继续对话" rows="1">' + esc(draft) + '</textarea>' +
    (busy ? '<button type="button" class="stop-btn" id="stop" aria-label="停止">' + icon("stop") + '</button>' : '') +
    '<button class="send-btn" id="send" aria-label="' + (busy ? "加入队列" : "发送") + '">' + icon("send") + '</button>' +
    '</div><div class="meta"><span>' + esc(queue) + '</span>' +
    (snapshot.queuedCount ? '<button type="button" id="clear">清空队列</button>' : '') +
    '</div></form>';
}

function bindList(root) {
  const dismiss = root.querySelector("#dismiss-notice");
  if (dismiss) dismiss.onclick = function () { localStorage.setItem(NOTICE_KEY, "1"); render(); };
  const refresh = root.querySelector("#refresh");
  if (refresh) refresh.onclick = function () {
    loadList().then(function () { error = ""; render(); }).catch(function (err) { error = err.message; render(); });
  };
  const toggleSearch = root.querySelector("#toggle-search");
  if (toggleSearch) toggleSearch.onclick = function () { searchOpen = !searchOpen; searchFocused = searchOpen; render(); };
  root.querySelectorAll("[data-toggle]").forEach(function (el) {
    el.onclick = function () {
      toggleOpen(el.getAttribute("data-toggle"), defaultOpenPaths(filteredGroups()));
      render();
    };
  });
  root.querySelectorAll(".session-row").forEach(function (el) {
    el.addEventListener("click", function () {
      const workerId = el.getAttribute("data-worker");
      const cwd = el.getAttribute("data-cwd");
      const sessionPath = el.getAttribute("data-path") || undefined;
      openSession(cwd, sessionPath, workerId || undefined).catch(function (err) { error = err.message; render(); });
    });
  });
  ;["filter", "filter-wide"].forEach(function (id) {
    const filter = root.querySelector("#" + id);
    if (!filter) return;
    filter.addEventListener("input", function () {
      query = filter.value;
      searchFocused = true;
      const pane = document.getElementById("list-scroll");
      listScroll = pane ? pane.scrollTop : 0;
      render();
    });
    filter.addEventListener("blur", function () { searchFocused = false; });
    if (searchFocused) {
      filter.focus();
      const end = filter.value.length;
      filter.setSelectionRange(end, end);
    }
  });
  const pane = root.querySelector("#list-scroll");
  if (pane) {
    pane.scrollTop = listScroll;
    pane.addEventListener("scroll", function () { listScroll = pane.scrollTop; }, { passive: true });
  }
}

function bindChat(root) {
  const back = root.querySelector("#back");
  if (back) back.onclick = function () { go("/"); };
  const draftEl = root.querySelector("#draft");
  if (draftEl) {
    draftEl.addEventListener("input", function () { draft = draftEl.value; });
    draftEl.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        root.querySelector("#send").click();
      }
    });
  }
  const sendBtn = root.querySelector("#send");
  const form = root.querySelector("#composer");
  if (form) form.onsubmit = function (event) { event.preventDefault(); if (sendBtn) sendBtn.click(); };
  if (sendBtn) sendBtn.onclick = function (event) {
    event.preventDefault();
    const text = (draftEl && draftEl.value) || "";
    send(text).then(function () { draft = ""; render(); }).catch(function (err) { error = err.message; render(); });
  };
  const stop = root.querySelector("#stop");
  if (stop) stop.onclick = function () { abort().catch(function (err) { error = err.message; render(); }); };
  const clear = root.querySelector("#clear");
  if (clear) clear.onclick = function () { clearQueue().catch(function (err) { error = err.message; render(); }); };
  root.querySelectorAll("[data-allow]").forEach(function (el) {
    el.onclick = function () { respond(el.getAttribute("data-allow"), true); };
  });
  root.querySelectorAll("[data-deny]").forEach(function (el) {
    el.onclick = function () { respond(el.getAttribute("data-deny"), false); };
  });
  const chat = root.querySelector("#chat-scroll");
  if (chat) {
    if (pinBottom) chat.scrollTop = chat.scrollHeight;
    chat.addEventListener("scroll", function () {
      pinBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 48;
    }, { passive: true });
  }
}

function bindChrome(root) {
  root.querySelectorAll("#theme, #theme-chat").forEach(function (el) {
    el.onclick = function (event) {
      event.stopPropagation();
      themeMenu = !themeMenu;
      render();
    };
  });
  root.querySelectorAll("[data-theme]").forEach(function (el) {
    el.onclick = function () { applyTheme(el.getAttribute("data-theme")); themeMenu = false; render(); };
  });
  root.querySelectorAll("[data-copy]").forEach(function (el) {
    el.onclick = function (event) {
      event.preventDefault();
      copyText(el.getAttribute("data-copy-id") || "copy", decodeURIComponent(el.getAttribute("data-copy") || ""));
    };
  });
}

function renderAuth() {
  app.innerHTML = '<div class="auth"><header class="top"><h1>Pi 远程对话</h1>' +
    '<button type="button" class="icon-btn" id="theme" aria-label="主题">' + icon("palette") + "</button>" +
    themeMenuHtml() + "</header>" +
    '<div class="notice"><p>' + esc(SECURITY) + "</p></div>" +
    '<p class="empty">请在桌面设置中显示配对码，用这台设备扫描。网关只在本机回环和当前局域网私网地址上监听。</p>' +
    (error ? '<p class="notice" role="alert">' + esc(error) + "</p>" : "") + "</div>";
  bindChrome(app);
}

function render() {
  if (!token) return renderAuth();
  const view = route.startsWith("/s/") ? "chat" : "list";
  app.className = "app";
  app.dataset.view = view;
  app.innerHTML = '<aside class="pane-list">' + listPaneHtml() + '</aside><section class="pane-chat">' +
    chatPaneHtml() + "</section>";
  bindList(app);
  bindChat(app);
  bindChrome(app);
}

(async function boot() {
  try {
    await pairIfNeeded();
    if (token) await loadList();
    if (route.startsWith("/s/")) {
      snapshot = await api("/api/sessions/" + encodeURIComponent(route.slice(3)));
      watch(route.slice(3));
    }
  } catch (err) {
    error = err.message;
  }
  render();
})();
`
}

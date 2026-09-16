export function mobilePageCss(): string {
  return `
:root {
  color-scheme: dark;
  --bg: #0b0b0c;
  --surface: #161618;
  --raised: #1c1c1f;
  --composer: #232326;
  --line: #2c2c30;
  --text: #ececef;
  --muted: #8b8b91;
  --accent: #3dd68c;
  --accent-dim: #163528;
  --run: #5b8cff;
  --ask: #d7a441;
  --danger: #d46a6a;
  --shadow: 0 8px 28px rgb(0 0 0 / 35%);
  --radius: 12px;
}
[data-theme="light"] {
  color-scheme: light;
  --bg: #f3f3f5;
  --surface: #ffffff;
  --raised: #ffffff;
  --composer: #f6f6f8;
  --line: #e4e4ea;
  --text: #1c1c1f;
  --muted: #6d6d75;
  --accent: #1f9d62;
  --accent-dim: #e5f6ec;
  --run: #3b6fe0;
  --ask: #b8860b;
  --danger: #c04545;
  --shadow: 0 8px 24px rgb(20 20 30 / 8%);
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    color-scheme: light;
    --bg: #f3f3f5;
    --surface: #ffffff;
    --raised: #ffffff;
    --composer: #f6f6f8;
    --line: #e4e4ea;
    --text: #1c1c1f;
    --muted: #6d6d75;
    --accent: #1f9d62;
    --accent-dim: #e5f6ec;
    --run: #3b6fe0;
    --ask: #b8860b;
    --danger: #c04545;
    --shadow: 0 8px 24px rgb(20 20 30 / 8%);
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text);
  font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
button, textarea, input { font: inherit; color: inherit; }
button { background: var(--composer); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; }
button.primary { background: var(--accent); border-color: transparent; color: #08150f; font-weight: 600; }
button.danger { color: var(--danger); background: transparent; }
button:disabled { opacity: .45; }
button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
a { color: var(--run); }
.app { display: flex; height: 100dvh; height: 100svh; }
.pane-list, .pane-chat {
  display: flex; flex-direction: column; min-width: 0; min-height: 0;
}
.pane-list { background: var(--bg); }
.pane-chat { background: var(--bg); flex: 1; }
.top {
  position: sticky; top: 0; z-index: 4;
  display: flex; align-items: center; gap: 8px;
  min-height: 48px; padding: 6px 12px calc(6px + env(safe-area-inset-top) * 0);
  padding-top: max(6px, env(safe-area-inset-top));
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: blur(16px);
  border-bottom: 1px solid var(--line);
}
.top h1 { font-size: 16px; margin: 0; font-weight: 600; flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.icon-btn {
  width: 36px; height: 36px; padding: 0; border: 0; background: transparent; color: var(--text);
  border-radius: 8px; flex-shrink: 0; display: grid; place-items: center;
}
.icon-btn svg { width: 18px; height: 18px; }
.connect {
  display: flex; align-items: center; gap: 8px;
  margin: 8px 12px 0; padding: 8px 10px;
  border: 1px solid var(--line); background: var(--surface); border-radius: 10px;
  color: var(--muted); font-size: 12px;
}
.live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent); flex-shrink: 0; }
.notice {
  display: flex; align-items: center; gap: 8px;
  margin: 8px 12px 0; padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--ask) 50%, var(--line));
  background: color-mix(in srgb, var(--ask) 12%, var(--surface));
  border-radius: 10px; color: var(--text); font-size: 12px; line-height: 1.35;
}
.notice p { margin: 0; flex: 1; min-width: 0; }
.toolbar {
  display: flex; align-items: center; gap: 8px; padding: 10px 12px 6px;
}
.toolbar .label { flex: 1; min-width: 0; }
.toolbar .label strong { display: block; font-size: 13px; font-weight: 600; }
.toolbar .label small { color: var(--muted); font-size: 11px; }
.search-box {
  margin: 0 12px 10px; display: none;
}
.search-box.is-on { display: block; }
.search-box input, .search-wide input {
  width: 100%; height: 36px; padding: 0 10px; border-radius: 9px;
  border: 1px solid var(--line); background: var(--composer);
}
.search-wide { padding: 0 12px 10px; }
.list-scroll { flex: 1; overflow: auto; padding: 0 12px 16px; }
.project {
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius);
  margin: 0 0 10px; overflow: hidden;
}
.project-head {
  width: 100%; display: flex; align-items: center; gap: 8px;
  padding: 10px 12px; background: transparent; border: 0; text-align: left; border-radius: 0;
}
.folder { width: 28px; height: 28px; border-radius: 8px; background: var(--composer);
  display: grid; place-items: center; color: var(--muted); flex-shrink: 0; }
.folder svg { width: 15px; height: 15px; }
.project-head .meta { flex: 1; min-width: 0; }
.project-head .name { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 14px; }
.project-head .name span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.local { font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 999px;
  background: var(--composer); color: var(--muted); border: 1px solid var(--line); flex-shrink: 0; }
.project-head .sub { color: var(--muted); font-size: 11px; margin-top: 2px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.count { color: var(--muted); font-size: 12px; flex-shrink: 0; }
.chevron { color: var(--muted); transition: transform .15s ease; }
.project.is-open .chevron { transform: rotate(90deg); }
.project-sessions { display: none; border-top: 1px solid var(--line); }
.project.is-open .project-sessions { display: block; }
.session-row {
  width: 100%; min-height: 44px; margin: 0; padding: 8px 12px 8px 16px;
  display: flex; align-items: center; gap: 10px;
  text-align: left; background: transparent; border: 0; border-radius: 0; border-bottom: 1px solid var(--line);
}
.project-sessions .session-row:last-child { border-bottom: 0; }
.session-row:active, .session-row.is-on { background: color-mix(in srgb, var(--text) 6%, transparent); }
.session-row.is-on { box-shadow: inset 2px 0 0 var(--accent); }
.session-row .title {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px;
}
.session-row .when { flex-shrink: 0; color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.pill {
  flex-shrink: 0; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px;
  border: 1px solid transparent;
}
.pill.ok { background: var(--accent-dim); color: var(--accent); }
.pill.run { background: color-mix(in srgb, var(--run) 18%, transparent); color: var(--run); }
.pill.ask { background: color-mix(in srgb, var(--ask) 18%, transparent); color: var(--ask); }
.pill.err { background: color-mix(in srgb, var(--danger) 18%, transparent); color: var(--danger); }
.pill.idle { background: var(--composer); color: var(--muted); }
.empty { padding: 48px 24px; text-align: center; color: var(--muted); font-size: 13px; }
.chat-scroll { flex: 1; overflow: auto; padding: 8px 0 12px; }
.subhead {
  padding: 8px 16px 4px; font-size: 13px; color: var(--muted);
  display: flex; align-items: center; gap: 8px;
}
.subhead strong { color: var(--text); font-size: 15px; font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.node { padding: 6px 16px; }
.user { display: flex; justify-content: flex-end; }
.user .bubble { max-width: 86%; background: var(--raised); border: 1px solid var(--line);
  border-radius: 14px; padding: 8px 12px; margin: 0; white-space: pre-wrap; }
.assistant { padding: 4px 16px 6px; font-size: 15px; line-height: 1.55; }
.assistant h1, .assistant h2, .assistant h3 { font-size: 16px; margin: 12px 0 6px; }
.assistant p { margin: 0 0 8px; }
.assistant ul, .assistant ol { margin: 0 0 8px; padding-left: 1.3em; }
.assistant code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  background: var(--composer); border-radius: 4px; padding: 1px 5px; }
.assistant pre { overflow: auto; background: var(--surface); border: 1px solid var(--line);
  border-radius: 10px; padding: 10px 12px; margin: 0 0 10px; }
.assistant pre code { background: transparent; padding: 0; font-size: 12px; }
.think, .tool, .model {
  color: var(--muted); font-size: 12px; padding: 3px 16px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.error, .stopped { color: var(--danger); font-size: 13px; white-space: pre-wrap; }
.msg-bar {
  display: flex; align-items: center; gap: 8px; padding: 0 16px 8px;
  color: var(--muted); font-size: 11px;
}
.msg-bar svg { width: 13px; height: 13px; }
.user + .msg-bar { justify-content: flex-end; }
.msg-bar button { background: transparent; border: 0; padding: 4px; color: var(--muted); }
.msg-bar button.is-copied { color: var(--accent); }
.approval {
  margin: 8px 16px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--ask) 50%, var(--line));
  background: color-mix(in srgb, var(--ask) 10%, var(--surface)); border-radius: 10px; font-size: 13px;
}
.approval .actions { display: flex; gap: 8px; margin-top: 8px; }
.composer {
  position: sticky; bottom: 0; z-index: 4;
  padding: 8px 12px calc(10px + env(safe-area-inset-bottom));
  background: color-mix(in srgb, var(--bg) 92%, transparent);
  backdrop-filter: blur(16px);
}
.composer-box {
  display: flex; flex-direction: column;
  background: var(--surface); border: 1px solid var(--line); border-radius: 18px;
  box-shadow: var(--shadow); overflow: hidden;
}
.composer textarea {
  width: 100%; min-height: 44px; max-height: 140px; resize: none; border: 0;
  background: transparent; padding: 12px 16px 4px; line-height: 1.45; outline: none;
}
.composer textarea::placeholder { color: var(--muted); }
.composer-toolbar {
  display: flex; align-items: center; gap: 8px;
  min-height: 44px; padding: 2px 6px 8px 10px;
}
.composer-tools {
  display: flex; align-items: center; flex-wrap: nowrap; gap: 6px;
  flex: 1; min-width: 0; overflow: hidden;
}
.composer-chip {
  display: inline-flex; align-items: center;
  max-width: min(34vw, 160px); height: 28px; padding: 0 9px;
  border: 1px solid var(--line); border-radius: 999px; background: var(--composer);
  color: var(--muted); font-size: 12px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 1;
}
.composer-chip.is-run {
  color: var(--run); border-color: color-mix(in srgb, var(--run) 40%, var(--line));
}
.composer-chip.is-warn {
  color: var(--ask); border-color: color-mix(in srgb, var(--ask) 45%, var(--line));
}
.composer-model { color: var(--text); }
.composer-stop, .composer-clear { flex-shrink: 0; }
.composer-stop {
  min-width: 44px; height: 32px; padding: 0 12px; border: 0; border-radius: 999px;
  background: var(--danger); color: #fff; font-weight: 600; font-size: 12px;
}
.composer-clear {
  min-height: 32px; padding: 0 8px; border: 0; background: transparent;
  color: var(--muted); font-size: 12px;
}
.send-btn {
  width: 36px; height: 36px; border-radius: 50%; padding: 0; border: 0;
  display: grid; place-items: center; flex-shrink: 0;
  background: var(--accent); color: #08150f;
}
.send-btn svg { width: 18px; height: 18px; }
.send-btn.is-queue { background: var(--text); color: var(--bg); font-size: 11px; font-weight: 700; }
.send-btn:disabled { opacity: .35; }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0,0,0,0); border: 0;
}
.theme-menu {
  position: absolute; right: 12px; top: 48px; z-index: 6;
  min-width: 148px; padding: 6px; background: var(--surface); border: 1px solid var(--line);
  border-radius: 10px; box-shadow: var(--shadow);
}
.theme-menu button { display: block; width: 100%; text-align: left; background: transparent; border: 0;
  padding: 8px 10px; border-radius: 8px; }
.theme-menu button.is-on { background: var(--composer); }
.auth { max-width: 420px; margin: 12vh auto; padding: 0 16px; }
.wide-empty { flex: 1; display: grid; place-items: center; color: var(--muted); padding: 24px; text-align: center; }
@media (max-width: 899px) {
  .app[data-view="list"] .pane-chat { display: none; }
  .app[data-view="chat"] .pane-list { display: none; }
  .pane-list, .pane-chat { flex: 1; width: 100%; }
  .search-wide { display: none; }
}
@media (min-width: 900px) {
  .pane-list { width: 340px; flex: 0 0 340px; border-right: 1px solid var(--line); }
  .back-btn { display: none; }
  .search-box { display: none !important; }
  .search-wide { display: block; }
  .list-search-btn { display: none; }
  .pane-chat #theme-chat, .pane-chat .theme-menu { display: none; }
  .composer { padding: 10px 20px calc(14px + env(safe-area-inset-bottom)); }
  .composer-box { border-radius: 16px; }
}
`.trim()
}

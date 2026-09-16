// Fixed code only, executed in the Main-owned world. No page-world bridge.
export const TARGET_BOOTSTRAP = String.raw`
(() => {
  if (globalThis.__piBrowserTargets) return;
  let currentDocument = document;
  let root = document.documentElement;
  let nonce = '';
  const slots = new Map();
  const clear = () => { slots.clear(); nonce = ''; };
  const changed = (records) => {
    if (records.some(record => record.type === 'childList' && record.target === currentDocument)) clear();
  };
  const observer = new MutationObserver(changed);
  observer.observe(currentDocument, { childList: true });
  const checkDocument = () => {
    changed(observer.takeRecords());
    if (currentDocument !== document || root !== document.documentElement) clear();
  };
  const short = (value, size) => String(value || '').slice(0, size).replace(/\s+/g, ' ').trim();
  const nameText = element => {
    if (element instanceof HTMLInputElement) return ['button', 'submit', 'reset'].includes(element.type) ? short(element.value, 180) : '';
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let node, text = '', visits = 0;
    while (text.length < 180 && visits++ < 200 && (node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) text += node.data.slice(0, 180 - text.length);
    }
    return text;
  };
  const describe = element => ({
    role: short(element.getAttribute('role') || ({ a: 'link', button: 'button', input: 'textbox', textarea: 'textbox', select: 'combobox' })[element.localName] || element.localName, 64),
    name: short(element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.getAttribute('title') || nameText(element), 180),
    href: short(element.getAttribute('href'), 1024),
    type: short(element.localName + ':' + (element.type || ''), 80)
  });
  // Display truncation must not hide changes to explicit semantic metadata.
  // Keep at most 8192 UTF-16 code units per target, privately in this world;
  // decline over-budget targets rather than granting unverifiable references.
  const identity = element => {
    const values = [];
    let size = 0;
    const add = value => {
      size += value.length;
      if (size > 8192) return false;
      values.push(value);
      return true;
    };
    for (const attribute of ['role', 'aria-label', 'placeholder', 'title', 'href']) {
      if (!add(element.getAttribute(attribute) || '')) return null;
    }
    if (element instanceof HTMLAnchorElement && !add(element.href)) return null;
    if (element instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(element.type) && !add(element.value)) return null;
    return values;
  };
  const visible = element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility === 'visible' && style.display !== 'none';
  };
  const resolve = token => {
    checkDocument();
    const entry = slots.get(token);
    if (!nonce || !entry || entry.nonce !== nonce || entry.element.ownerDocument !== currentDocument || !entry.element.isConnected) throw Error('Stale browser target');
    const currentIdentity = identity(entry.element);
    if (!currentIdentity || currentIdentity.length !== entry.identity.length || currentIdentity.some((value, index) => value !== entry.identity[index])) throw Error('Stale browser target');
    if (JSON.stringify(describe(entry.element)) !== JSON.stringify(entry.description)) throw Error('Stale browser target');
    return entry.element;
  };
  globalThis.__piBrowserTargets = Object.freeze({
    snapshot(nextNonce) {
      clear(); currentDocument = document; root = document.documentElement;
      observer.takeRecords(); observer.disconnect(); observer.observe(document, { childList: true });
      nonce = nextNonce;
      const items = [];
      const walker = document.createTreeWalker(document.body || document, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      let visits = 0, content = '', incomplete = false, node;
      while ((node = walker.nextNode())) {
        if (++visits > 4000) { incomplete = true; break; }
        if (node.nodeType === Node.TEXT_NODE) {
          if (!['SCRIPT', 'STYLE'].includes(node.parentElement?.tagName)) {
            const remaining = 6000 - content.length;
            if (node.length > remaining) incomplete = true;
            content += node.data.slice(0, remaining);
          }
          continue;
        }
        if (!node.matches('a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[role="link"],[contenteditable="true"],[tabindex]:not([tabindex="-1"])') || !visible(node)) continue;
        if (items.length >= 160) { incomplete = true; break; }
        const semanticIdentity = identity(node);
        if (!semanticIdentity) { incomplete = true; continue; }
        const description = describe(node);
        const token = nonce + ':' + (items.length + 1);
        items.push({ token, ...description });
        slots.set(token, { element: node, nonce, description, identity: semanticIdentity });
      }
      const title = short(document.title, 256);
      let text = title + '\n' + content + '\n';
      const published = [];
      const marker = '\n[Snapshot incomplete]';
      for (const item of items) {
        const row = JSON.stringify(item) + '\n';
        if (text.length + row.length > 20000 - marker.length) { incomplete = true; break; }
        text += row; published.push(item);
      }
      for (const item of items.slice(published.length)) slots.delete(item.token);
      if (incomplete) text += marker;
      return { nonce, title, content, text, incomplete, items: published };
    },
    locate(token) {
      const element = resolve(token);
      element.scrollIntoView({ block: 'center', inline: 'center' });
      resolve(token);
      if (!visible(element) || element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true') throw Error('Target unavailable');
      const rect = element.getBoundingClientRect();
      const x = Math.max(0, rect.left) + (Math.min(innerWidth, rect.right) - Math.max(0, rect.left)) / 2;
      const y = Math.max(0, rect.top) + (Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top)) / 2;
      const hit = document.elementFromPoint(x, y);
      if (!hit || !(hit === element || element.contains(hit))) throw Error('Target obscured');
      return { nonce, x, y, width: innerWidth, height: innerHeight };
    },
    fill({ token, value }) {
      const element = resolve(token);
      const supportedInput = () => element instanceof HTMLInputElement && ['text', 'search', 'tel', 'url', 'email', 'password', 'number'].includes(element.type);
      const editable = () => (supportedInput() || element instanceof HTMLTextAreaElement || element.isContentEditable) && !element.matches(':disabled') && !element.readOnly && element.getAttribute('aria-disabled') !== 'true' && visible(element);
      if (!editable()) throw Error('Target not editable');
      element.focus();
      resolve(token);
      if (!editable()) throw Error('Target not editable');
      const input = supportedInput();
      const textarea = element instanceof HTMLTextAreaElement;
      if (input || textarea) Object.getOwnPropertyDescriptor(input ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, 'value').set.call(element, value);
      else element.textContent = value;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    select({ token, value }) {
      const element = resolve(token);
      if (!(element instanceof HTMLSelectElement) || element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true' || !visible(element)) throw Error('Target not selectable');
      let option;
      for (let i = 0; i < Math.min(element.options.length, 4000); i++) {
        const candidate = element.options[i];
        if (candidate.value === value || candidate.text === value) { option = candidate; break; }
      }
      if (!option || option.disabled || option.parentElement?.disabled) throw Error('Option unavailable');
      // selectedIndex targets this validated option even when values repeat,
      // preserving the existing single-selection behavior for multiple selects.
      element.selectedIndex = option.index;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    invalidate() { clear(); return true; },
    dispose() { clear(); observer.disconnect(); delete globalThis.__piBrowserTargets; return true; }
  });
})()
`

export function targetCall(
  method: 'snapshot' | 'locate' | 'fill' | 'select' | 'invalidate' | 'dispose',
  argument?: string | { token: string; value: string }
): string {
  return `${TARGET_BOOTSTRAP}\nglobalThis.__piBrowserTargets.${method}(${argument === undefined ? '' : JSON.stringify(argument)})`
}

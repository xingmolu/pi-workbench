export const INTERACTIVE_SNAPSHOT_SCRIPT = String.raw`
(() => {
  const selectorFor = (element) => {
    if (!(element instanceof Element)) return '';
    if (element.id) return '#' + CSS.escape(element.id);
    const parts = [];
    let current = element;
    while (current && current instanceof Element && parts.length < 8) {
      let part = current.localName;
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.localName === current.localName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(' > ');
  };
  const nameFor = (element) => {
    const labelledBy = element.getAttribute('aria-labelledby');
    const labelled = labelledBy ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ') : '';
    const nativeLabel = 'labels' in element && element.labels
      ? Array.from(element.labels).map((label) => label.textContent || '').join(' ')
      : element.closest('label')?.textContent || '';
    const input = element instanceof HTMLInputElement ? element : null;
    const valueLabel = input && ['button', 'submit', 'reset'].includes(input.type) ? input.value : '';
    return (
      element.getAttribute('aria-label') || labelled || nativeLabel || element.getAttribute('alt') ||
      element.getAttribute('placeholder') || element.getAttribute('title') || valueLabel ||
      element.textContent || ''
    ).replace(/\s+/g, ' ').trim().slice(0, 180);
  };
  const roleFor = (element) => {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit;
    if (element instanceof HTMLAnchorElement) return 'link';
    if (element instanceof HTMLButtonElement) return 'button';
    if (element instanceof HTMLSelectElement) return 'combobox';
    if (element instanceof HTMLTextAreaElement) return 'textbox';
    if (element instanceof HTMLInputElement) {
      if (['checkbox', 'radio'].includes(element.type)) return element.type;
      if (['button', 'submit', 'reset'].includes(element.type)) return 'button';
      return 'textbox';
    }
    return element.isContentEditable ? 'textbox' : element.localName;
  };
  const elements = Array.from(document.querySelectorAll(
    'a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[role="link"],[contenteditable="true"],[tabindex]:not([tabindex="-1"])'
  ));
  const items = [];
  for (const element of elements) {
    if (items.length >= 160) break;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (rect.width < 1 || rect.height < 1 || style.visibility === 'hidden' || style.display === 'none') continue;
    const selector = selectorFor(element);
    if (!selector) continue;
    items.push({
      selector,
      role: roleFor(element),
      name: nameFor(element),
      disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true')
    });
  }
  const content = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 6000);
  return { title: document.title || '', url: location.href, content, items };
})()
`

export function elementRectScript(selector: string): string {
  return String.raw`
(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  element.scrollIntoView({ block: 'center', inline: 'center' });
  const next = element.getBoundingClientRect();
  return { x: next.left + next.width / 2, y: next.top + next.height / 2 };
})()
`
}

export function fillElementScript(selector: string, value: string): string {
  return String.raw`
(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!element) return false;
  element.focus();
  const nextValue = ${JSON.stringify(value)};
  if (element instanceof HTMLInputElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(element, nextValue);
  } else if (element instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(element, nextValue);
  } else if (element.isContentEditable) {
    element.textContent = nextValue;
  } else return false;
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: nextValue }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()
`
}

export function selectElementScript(selector: string, value: string): string {
  return String.raw`
(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!(element instanceof HTMLSelectElement)) return false;
  const option = Array.from(element.options).find((item) => item.value === ${JSON.stringify(value)} || item.text === ${JSON.stringify(value)});
  if (!option) return false;
  element.value = option.value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()
`
}

export function pageContainsTextScript(text: string): string {
  return `Boolean(document.body?.innerText.includes(${JSON.stringify(text)}))`
}

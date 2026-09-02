/**
 * The element builders every surface shares. DOM only — no `chrome.*`, and
 * nothing touches `document` until a function is called, so the module imports
 * cleanly wherever it is pulled in.
 */

export interface ElOptions {
  class?: string;
  id?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string>;
  children?: (Node | string)[];
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElOptions = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.id) node.id = options.id;
  if (options.title) node.title = options.title;
  if (options.text !== undefined) node.textContent = options.text;
  for (const [name, value] of Object.entries(options.attrs ?? {})) node.setAttribute(name, value);
  if (options.children) node.append(...options.children);
  return node;
}

export function mark(text: string): HTMLElement {
  const node = document.createElement('mark');
  node.textContent = text;
  return node;
}

let uid = 0;

export function nextId(prefix: string): string {
  uid += 1;
  return `${prefix}-${uid}`;
}

/**
 * Small stateless widgets the options views assemble panels from. Pure DOM
 * builders: no `chrome.*`, no store access. Each one used to live inline in
 * `options.ts`; moved here verbatim so every view can share them without
 * pulling in the page's routing or persistence.
 */

import { el, nextId } from '../ui/dom';
import type { Problem } from './model/form';

export function button(label: string, onClick: () => void, className = 'btn'): HTMLButtonElement {
  const node = el('button', { class: className, text: label, attrs: { type: 'button' } });
  node.addEventListener('click', onClick);
  return node;
}

/** The two glyphs the row actions use, as path data for a 16px viewBox. Built
 *  with `createElementNS` rather than markup so nothing here ever parses HTML. */
export const ICONS = {
  pencil:
    'M11.5 2.5a1.4 1.4 0 0 1 2 2L6 12l-3 1 1-3 7.5-7.5zM10 4l2 2',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M6.8 7v4M9.2 7v4',
} as const;

export function icon(name: keyof typeof ICONS): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

/**
 * A button that is only a glyph. The label goes to `aria-label` and `title`,
 * so it is read out and shown on hover but never takes up row width.
 */
export function iconButton(
  label: string,
  name: keyof typeof ICONS,
  onClick: () => void,
  className = 'btn btn-sm btn-ghost btn-icon',
): HTMLButtonElement {
  const node = el('button', {
    class: className,
    title: label,
    attrs: { type: 'button', 'aria-label': label },
    children: [icon(name)],
  });
  node.addEventListener('click', onClick);
  return node;
}

/**
 * Two-step destructive action. A modal `confirm()` inside an extension page is
 * a worse interruption than arming the button in place, but arming must not
 * turn a double-click into a single destructive gesture, so the confirming
 * click has to arrive as its own deliberate click, after the label has had time
 * to be read.
 */
const CONFIRM_DELAY_MS = 400;

export function confirmButton(
  idle: string,
  armed: string,
  className: string,
  action: () => void,
  glyph?: keyof typeof ICONS,
  /** A standing sentence appended to the tooltip in both states. It cannot be
   *  set on the returned node, because disarming rewrites the title. */
  hint = '',
): HTMLButtonElement {
  let armedAt = 0;
  let timer = 0;
  // A held Enter repeats `click` with `detail === 0`, so the double-click guard
  // never sees it; the confirming activation has to follow a key release.
  let released = false;
  const node = el('button', {
    class: className,
    attrs: { type: 'button', 'aria-live': 'polite' },
  });
  // A glyph button still carries the words, in a visually-hidden span rather
  // than an `aria-label`: `aria-live` announces a change to the region's TEXT,
  // and an attribute rewritten in place is silent, which would lose the one
  // state change worth announcing here. Same span the switch labels use.
  const name = glyph ? el('span', { class: 'visually-hidden' }) : node;
  if (glyph) node.append(icon(glyph), name);
  const say = (label: string): void => {
    name.textContent = label;
    if (glyph || hint) node.title = hint ? `${label}. ${hint}` : label;
  };
  say(idle);

  const disarm = (): void => {
    window.clearTimeout(timer);
    armedAt = 0;
    say(idle);
    node.classList.remove('btn-armed');
  };

  node.addEventListener('click', (event) => {
    // The second click of a double-click carries detail 2; it is one gesture,
    // not two decisions.
    if (event.detail > 1) return;
    if (armedAt === 0) {
      armedAt = Date.now();
      released = false;
      say(armed);
      node.classList.add('btn-armed');
      timer = window.setTimeout(disarm, 4000);
      return;
    }
    if (!released) return;
    if (Date.now() - armedAt < CONFIRM_DELAY_MS) return;
    disarm();
    action();
  });
  // Both fire before the `click` they belong to, so a real second gesture is
  // already marked released by the time the handler above runs.
  node.addEventListener('keyup', () => {
    released = true;
  });
  node.addEventListener('pointerup', () => {
    released = true;
  });
  node.addEventListener('blur', disarm);
  return node;
}

export function textInput(value: string, placeholder = '', mono = false): HTMLInputElement {
  const input = el('input', {
    class: mono ? 'input mono' : 'input',
    attrs: { type: 'text', placeholder, autocomplete: 'off', spellcheck: 'false' },
  });
  input.value = value;
  return input;
}

export function selectControl(
  options: { value: string; label: string }[],
  value: string,
): HTMLSelectElement {
  const node = el('select', { class: 'select' });
  for (const option of options) {
    const item = el('option', { text: option.label });
    item.value = option.value;
    node.append(item);
  }
  node.value = value;
  return node;
}

export function checkbox(label: string, checked: boolean, onChange: (on: boolean) => void): HTMLElement {
  const input = el('input', { attrs: { type: 'checkbox' } });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', { class: 'check', children: [input, label] });
}

export function switchControl(
  label: string,
  checked: boolean,
  onChange: (on: boolean) => void,
): HTMLElement {
  const input = el('input', { attrs: { type: 'checkbox' } });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', {
    class: 'switch',
    children: [input, el('span', { class: 'visually-hidden', text: label })],
  });
}

/**
 * Marks a control mandatory: `required`/`aria-required="true"` on the control
 * itself, which is what a screen reader actually announces, plus a visible red
 * asterisk on the label for sighted users. The asterisk carries
 * `aria-hidden="true"` rather than its own wording, since `aria-required`
 * already speaks for the control and the label text already names it; a
 * second spoken "required" on top of that would repeat on every visit.
 */
function markRequired(control: HTMLElement, labelNode: HTMLElement): void {
  control.setAttribute('required', '');
  control.setAttribute('aria-required', 'true');
  labelNode.append(el('span', { class: 'req', text: '*', attrs: { 'aria-hidden': 'true' } }));
}

export function field(
  label: string,
  control: HTMLElement,
  hint?: string,
  wide = false,
  required = false,
): HTMLElement {
  if (!control.id) control.id = nextId('field');
  const labelNode = el('label', { class: 'field-label', text: label });
  labelNode.htmlFor = control.id;
  if (required) markRequired(control, labelNode);
  const children: Node[] = [labelNode, control];
  if (hint) {
    const hintNode = el('p', { class: 'field-hint', id: `${control.id}-hint`, text: hint });
    control.setAttribute('aria-describedby', hintNode.id);
    children.push(hintNode);
  }
  return el('div', { class: wide ? 'field wide' : 'field', children });
}

export interface FieldSlot {
  node: HTMLElement;
  setProblems: (problems: Problem[]) => void;
}

/**
 * A `field()` that owns its own validation messages: the problem text lives
 * inside the field wrapper and is wired to the control with `aria-describedby`,
 * so a screen reader reaching the input hears what is wrong with it rather than
 * finding an unattributed list further down the page.
 */
export function errorField(
  label: string,
  control: HTMLInputElement | HTMLSelectElement,
  errorId: string,
  hint?: string,
  wide = false,
  required = false,
): FieldSlot {
  const node = field(label, control, hint, wide, required);
  const hintId = control.getAttribute('aria-describedby') ?? '';
  const errors = el('div', {
    class: 'field-errors',
    id: errorId,
    attrs: { 'aria-live': 'polite' },
  });
  node.append(errors);

  return {
    node,
    setProblems(problems: Problem[]): void {
      errors.textContent = '';
      for (const problem of problems) {
        errors.append(
          el('p', {
            class: problem.level === 'error' ? 'msg msg-error' : 'msg msg-warn',
            text: problem.text,
          }),
        );
      }
      const failed = problems.some((problem) => problem.level === 'error');
      control.classList.toggle('bad', failed);
      if (failed) control.setAttribute('aria-invalid', 'true');
      else control.removeAttribute('aria-invalid');
      const described = [hintId, problems.length > 0 ? errorId : ''].filter(Boolean).join(' ');
      if (described) control.setAttribute('aria-describedby', described);
      else control.removeAttribute('aria-describedby');
    },
  };
}

export function panelCard(
  title: string,
  sub?: string,
): { section: HTMLElement; body: HTMLElement; saved: HTMLElement } {
  const saved = el('span', { class: 'saved', attrs: { role: 'status', 'aria-live': 'polite' } });
  const head = el('div', { class: 'panel-head' });
  const text = el('div', { class: 'panel-head-text', children: [el('h2', { class: 'panel-title', text: title })] });
  if (sub) text.append(el('p', { class: 'panel-sub', text: sub }));
  head.append(text, saved);

  const body = el('div', { class: 'panel-body' });
  return { section: el('section', { class: 'panel', children: [head, body] }), body, saved };
}

const flashTimers = new WeakMap<HTMLElement, number>();

export function flash(node: HTMLElement, text = 'Saved'): void {
  window.clearTimeout(flashTimers.get(node));
  node.textContent = text;
  node.classList.add('show');
  flashTimers.set(node, window.setTimeout(() => node.classList.remove('show'), 1800));
}

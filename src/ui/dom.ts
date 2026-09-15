/** Small typed helpers over the static markup in index.html. */

export function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

export function show(node: HTMLElement, visible: boolean): void {
  node.classList.toggle('hidden', !visible);
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function button(label: string, className = ''): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = label;
  if (className) node.className = className;
  return node;
}

export interface ToggleRow {
  row: HTMLLabelElement;
  input: HTMLInputElement;
}

export function toggleRow(title: string, description: string, checked: boolean): ToggleRow {
  const row = document.createElement('label');
  row.className = 'row toggle';

  const text = document.createElement('span');
  const strong = document.createElement('strong');
  strong.textContent = title;
  const small = document.createElement('small');
  small.textContent = description;
  text.append(strong, small);

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;

  row.append(text, input);
  return { row, input };
}

export function selectRow<T extends string>(
  title: string,
  description: string,
  options: { value: T; label: string }[],
  value: T,
): { row: HTMLLabelElement; select: HTMLSelectElement } {
  const row = document.createElement('label');
  row.className = 'row';

  const text = document.createElement('span');
  const strong = document.createElement('strong');
  strong.textContent = title;
  const small = document.createElement('small');
  small.textContent = description;
  text.append(strong, small);

  const select = document.createElement('select');
  for (const option of options) {
    const node = document.createElement('option');
    node.value = option.value;
    node.textContent = option.label;
    select.append(node);
  }
  select.value = value;

  row.append(text, select);
  return { row, select };
}

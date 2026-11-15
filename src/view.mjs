import { parse } from 'parse5';

export function controls(html) {
  const root = parse(html); const forms = [];
  function attribute(node, name) { return node.attrs?.find(item => item.name === name)?.value; }
  function visit(node, current) {
    if (node.tagName === 'form') { current = { id: attribute(node, 'id'), fields: {} }; forms.push(current); }
    if (current && node.tagName === 'input' && attribute(node, 'name')) current.fields[attribute(node, 'name')] = attribute(node, 'value') || '';
    for (const child of node.childNodes || []) visit(child, current);
  }
  visit(root, null); return forms;
}

export async function preview(source, store) {
  const response = await fetch(source.url + source.path);
  const html = await response.text();
  const evidence = store.saveEvidence('initial-view', { url: response.url }, Buffer.from(html));
  return { mode: 'initial-view', forms: controls(html), evidence };
}

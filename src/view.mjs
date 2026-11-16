import { parseDocument, formsOf } from './dom.mjs';

export function controls(html) {
  const { order, byId } = formsOf(parseDocument(html));
  return order.map(id => ({ id, fields: byId[id] }));
}

export async function preview(source, store) {
  const response = await fetch(source.url + source.path);
  const html = await response.text();
  const evidence = store.saveEvidence('initial-view', { url: response.url }, Buffer.from(html));
  return { mode: 'initial-view', forms: controls(html), evidence };
}

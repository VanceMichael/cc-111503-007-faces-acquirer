import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../src/portal.mjs';
import { preview } from '../src/view.mjs';
import { Inbox } from '../src/store.mjs';

test('initial view keeps the state of each form separate', async () => {
  const source = await fixture(); const store = new Inbox();
  try {
    const result = await preview(source, store);
    assert.equal(result.forms[0].fields['jakarta.faces.ViewState'], 'd1');
    assert.equal(result.forms[1].fields['jakarta.faces.ViewState'], 'o1');
  } finally { store.close(); await source.close(); }
});
test('portal rejects state borrowed from another form', async () => {
  const source = await fixture();
  try {
    const response = await fetch(source.url + source.path, { method: 'POST', headers: { 'Faces-Request': 'partial/ajax' },
      body: new URLSearchParams({ 'jakarta.faces.ViewState': 'o1' }) });
    assert.equal(response.status, 409);
  } finally { await source.close(); }
});

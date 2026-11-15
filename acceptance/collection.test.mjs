import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../src/portal.mjs';
import * as intake from '../src/intake.mjs';
import { Inbox } from '../src/store.mjs';

async function run(scenario, check) {
  assert.equal(typeof intake.collect, 'function', 'collection entry is not available yet');
  const source = await fixture(scenario); const store = new Inbox();
  try {
    const result = await intake.collect(source, store);
    await check(result, source, store);
  } finally { store.close(); await source.close(); }
}

test('the current institution and contacts come from one applied partial response', async () => {
  await run('normal', async (result, source) => {
    assert.equal(result.records[0].institution, 'Center A'); assert.equal(result.records[0].contact, 'Desk A');
    assert.equal(result.forms.directory['jakarta.faces.ViewState'], 'd3');
    assert.equal(result.forms.other['jakarta.faces.ViewState'], 'o3');
    assert.equal(source.requests[0]['jakarta.faces.ViewState'], 'd1');
    assert.equal(source.requests[1]['jakarta.faces.ViewState'], 'd2');
    assert.equal(source.requests[1]['jakarta.faces.source'], 'directory:row:siteA');
  });
});
for (const scenario of ['error', 'truncated', 'eval']) {
  test(scenario + ' does not publish a partially modified view', async () => {
    await run(scenario, async result => { assert.equal(result.records.length, 0); assert.ok(result.diagnostics.length); });
  });
}

test('deletion and sibling insertion participate in the same current view', async () => {
  await run('mutations', async result => { assert.equal(result.records[0].contact, 'Desk A'); });
});

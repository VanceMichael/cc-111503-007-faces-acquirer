import test from 'node:test';
import assert from 'node:assert/strict';
import { serve, body } from '../src/http.mjs';
import { collect } from '../src/intake.mjs';
import { Inbox } from '../src/store.mjs';

async function run(source, check) {
  const store = new Inbox();
  try {
    const result = await collect(source, store);
    await check(result, source, store);
  } finally {
    store.close();
    await source.close();
  }
}

const initial = `<!doctype html><html><body>
<form id="directory"><input type="hidden" name="jakarta.faces.ViewState" value="d1"><input name="city" value="C1">
<button id="directory:search">search</button><section id="matches">not searched</section>
<section id="details"><span data-field="institution">not selected</span></section>
<section id="contacts"><span data-field="contact">not selected</span></section></form>
<form id="other"><input name="jakarta.faces.ViewState" value="o1"></form>
<section id="templates"><button id="directory:row:ghost" data-institution="ghost">Ghost</button></section>
</body></html>`;

function searchUpdate(rows, viewState = 'd2') {
  const buttons = rows.map(row => `<button id="directory:row:${row}" data-institution="${row}">${row}</button>`).join('');
  return `<update id="matches"><![CDATA[<section id="matches">${buttons}</section>]]></update>
<update id="directory:jakarta.faces.ViewState"><![CDATA[${viewState}]]></update>`;
}

function expansion(body, viewState = 'd3') {
  return `<partial-response><changes>${body}
<update id="directory:jakarta.faces.ViewState"><![CDATA[${viewState}]]></update>
</changes></partial-response>`;
}

function details(id) {
  return `<update id="details"><![CDATA[<section id="details"><span data-field="institution">Center ${id}</span></section>]]></update>`;
}

function contacts(id) {
  return `<update id="contacts"><![CDATA[<section id="contacts"><span data-field="contact">Desk ${id}</span></section>]]></update>`;
}

async function simulator(handler) {
  const requests = [];
  let viewState = 'd1';
  const source = await serve(async (request, response) => {
    if (request.method === 'GET') {
      viewState = 'd1';
      response.writeHead(200, { 'content-type': 'text/html' });
      return response.end(initial);
    }
    const parameters = new URLSearchParams(await body(request));
    requests.push(Object.fromEntries(parameters));
    if (request.headers['faces-request'] !== 'partial/ajax'
      || parameters.get('jakarta.faces.ViewState') !== viewState) {
      response.writeHead(409);
      return response.end('wrong view state');
    }
    const xml = handler(parameters, state => { viewState = state; });
    response.writeHead(200, { 'content-type': 'text/xml' });
    response.end(xml);
  });
  return { ...source, path: '/directory', formId: 'directory', sourceId: 'directory:search', requests };
}

test('rows surfaced by search, not hidden page templates, drive expansion', async () => {
  const source = await simulator((parameters, setState) => {
    if (parameters.get('jakarta.faces.source') === 'directory:search') {
      setState('d2');
      return `<partial-response><changes>${searchUpdate(['siteA', 'siteB'])}</changes></partial-response>`;
    }
    const id = parameters.get('jakarta.faces.source').split(':').at(-1);
    setState('d3');
    return expansion(details(id) + contacts(id));
  });
  await run(source, async (result, fixture) => {
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.records.map(record => record.institution), ['Center siteA', 'Center siteB']);
    assert.deepEqual(result.records.map(record => record.contact), ['Desk siteA', 'Desk siteB']);
    assert.equal(result.records.every(record => record.status === 'complete'), true);
    assert.equal(fixture.requests.some(request => request['jakarta.faces.source'] === 'directory:row:ghost'), false);
    assert.equal(fixture.requests[1]['jakarta.faces.ViewState'], 'd2');
  });
});

test('a response that only refreshes the institution is not exported', async () => {
  const source = await simulator((parameters, setState) => {
    if (parameters.get('jakarta.faces.source') === 'directory:search') {
      setState('d2');
      return `<partial-response><changes>${searchUpdate(['siteA'])}</changes></partial-response>`;
    }
    setState('d3');
    return expansion(details('siteA'));
  });
  await run(source, async result => {
    assert.equal(result.records.length, 0);
    assert.equal(result.pending.length, 1);
    assert.equal(result.pending[0].reason, 'details-not-closed-together');
    assert.equal(result.pending[0].contact, 'not selected');
  });
});

test('a response that fails midway leaves the previous view and state untouched', async () => {
  const source = await simulator((parameters, setState) => {
    if (parameters.get('jakarta.faces.source') === 'directory:search') {
      setState('d2');
      return `<partial-response><changes>${searchUpdate(['siteA'])}</changes></partial-response>`;
    }
    setState('d3');
    return expansion(`${details('siteA')}${contacts('siteA')}<update id="missing"><![CDATA[<p>late</p>]]></update>`);
  });
  await run(source, async (result, fixture, store) => {
    assert.equal(result.status, 'incomplete');
    assert.equal(result.diagnostics.some(item => item.code === 'missing-target'), true);
    assert.equal(result.forms.directory['jakarta.faces.ViewState'], 'd2');
    assert.equal(result.forms.directory['jakarta.faces.ViewState'] === 'd3', false);
    assert.equal(result.records.length, 0);
    const stored = store.evidence();
    assert.equal(stored.some(item => item.kind === 'partial-response'), true);
    assert.equal(stored.some(item => item.kind === 'initial-view'), true);
    // No half-applied view evidence was recorded for the rejected response.
    assert.equal(stored.some(item => item.kind === 'applied-view'
      && item.metadata.response === result.evidence.at(-1)), false);
  });
});

test('a server redirect starts a new view instead of reusing old controls', async () => {
  let redirected = false;
  const source = await simulator((parameters, setState) => {
    if (parameters.get('jakarta.faces.source') === 'directory:search') {
      setState('d2');
      return `<partial-response><changes>${searchUpdate(['siteA'])}</changes></partial-response>`;
    }
    if (!redirected) {
      redirected = true;
      return '<partial-response><redirect url="/fresh"/></partial-response>';
    }
    setState('d3');
    return expansion(details('siteA') + contacts('siteA'));
  });
  await run(source, async (result, fixture) => {
    assert.equal(result.status, 'complete');
    assert.equal(result.records[0].institution, 'Center siteA');
    assert.equal(result.records[0].contact, 'Desk siteA');
    assert.equal(result.diagnostics.some(item => item.code === 'redirect-followed'), true);
    // The rejected expansion contributed no applied view; the new page was
    // entered and queried again before any row was expanded.
    const sources = fixture.requests.map(request => request['jakarta.faces.source']);
    assert.deepEqual(sources, [
      'directory:search', 'directory:row:siteA', 'directory:search', 'directory:row:siteA',
    ]);
    assert.equal(fixture.requests[2]['jakarta.faces.ViewState'], 'd1');
    assert.equal(result.evidence.length >= 5, true);
  });
});

test('raw page and partial responses stay available for inspection', async () => {
  const source = await simulator((parameters, setState) => {
    if (parameters.get('jakarta.faces.source') === 'directory:search') {
      setState('d2');
      return `<partial-response><changes>${searchUpdate(['siteA'])}</changes></partial-response>`;
    }
    setState('d3');
    return expansion(details('siteA') + contacts('siteA'));
  });
  await run(source, async (result, fixture, store) => {
    const stored = store.evidence();
    assert.equal(stored.filter(item => item.kind === 'partial-response').length, 2);
    assert.equal(stored.filter(item => item.kind === 'applied-view').length, 2);
    assert.equal(stored.filter(item => item.kind === 'initial-view').length, 1);
    assert.equal(new Set(result.evidence).size, result.evidence.length);
    assert.equal(result.views.length, 2);
    assert.deepEqual(result.views[1].changed,
      ['contacts', 'details', 'directory:jakarta.faces.ViewState']);

    // The raw partial response and the view it produced are both retrievable,
    // so an auditor can compare one expansion against what actually changed.
    const raw = store.getEvidence(result.evidence[2]);
    assert.equal(raw.kind, 'partial-response');
    assert.equal(raw.metadata.source, 'directory:row:siteA');
    assert.equal(raw.body.toString('utf8').includes('<update id="details">'), true);
    assert.equal(raw.body.toString('utf8').includes('<update id="contacts">'), true);
    const applied = store.getEvidence(result.views[1].id);
    assert.equal(applied.kind, 'applied-view');
    assert.equal(applied.metadata.response, result.evidence[2]);
    const viewText = applied.body.toString('utf8');
    assert.equal(viewText.includes('Center siteA'), true);
    assert.equal(viewText.includes('Desk siteA'), true);
    assert.equal(viewText.includes('not selected'), false);
  });
});

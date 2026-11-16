import { parsePartialResponse } from './partial.mjs';
import {
  applyOperations, attribute, findById, formFields, formOfControl, formsOf,
  institutionRows, parseDocument, readField, serializeDocument, viewStateOf, ViewError,
} from './dom.mjs';

const MAX_REDIRECTS = 2;
const MAX_ROUNDS = 20;

function diagnostic(code, message, extra = {}) {
  return { code, message, ...extra };
}

function formIdOf(document, controlId) {
  const form = formOfControl(document, controlId);
  return form ? (attribute(form, 'id') || null) : null;
}

function placeholder(value) {
  return /^not\s+selected$/i.test(value.trim());
}

function urlOf(source) {
  return new URL(source.path, source.url).toString();
}

/**
 * Enter the site. GET starts a new view and is only used for the entry page or
 * for a server-issued redirect; in both cases the old view is abandoned.
 */
async function loadView(target, store, kind, diagnostics) {
  let response;
  let bytes;
  try {
    response = await fetch(target, { redirect: 'follow' });
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    diagnostics.push(diagnostic('transport-error', error.message, { url: target }));
    return null;
  }
  const evidence = store.saveEvidence(kind, {
    url: response.url || target, status: response.status, method: 'GET',
  }, bytes);
  if (response.status !== 200) {
    diagnostics.push(diagnostic('view-unavailable', `view returned HTTP ${response.status}`, { evidence }));
    return null;
  }
  return { document: parseDocument(bytes.toString('utf8')), url: response.url || target, evidence };
}

/**
 * Drive the query through the site's own forms.
 *
 * Each partial response is applied to a private copy of the current view and
 * only replaces the live view when the whole response could be applied. A
 * record is emitted from that post-apply view, and only when the institution
 * and contact regions were both changed by the same response.
 */
export async function collect(source, store) {
  const collected = new Map();
  const pending = [];
  const diagnostics = [];
  const evidence = [];
  const views = [];
  const seenRows = new Set();
  let redirects = 0;
  let usable = true;
  let failReason = null;

  const initial = await loadView(urlOf(source), store, 'initial-view', diagnostics);
  if (!initial) {
    return {
      status: 'incomplete', records: [], forms: {}, pending, diagnostics, evidence, views,
      url: urlOf(source),
    };
  }
  let view = initial;
  evidence.push(initial.evidence);
  const records = () => [...collected.values()];

  function fail(items, evidenceId) {
    if (usable) failReason = items[0]?.code || 'failed';
    usable = false;
    for (const item of items) {
      diagnostics.push(evidenceId ? { ...item, evidence: evidenceId } : item);
    }
  }

  async function post(controlId) {
    const formId = formIdOf(view.document, controlId);
    if (!formId) {
      fail([diagnostic('missing-form', `control ${controlId} is not inside a form`)], null);
      return null;
    }
    const viewState = viewStateOf(view.document, controlId);
    if (viewState === null) {
      fail([diagnostic('missing-view-state', `form ${formId} has no ViewState`)], null);
      return null;
    }
    const parameters = new URLSearchParams({
      ...formFields(view.document, controlId),
      'jakarta.faces.ViewState': viewState,
      'jakarta.faces.partial.ajax': 'true',
      'jakarta.faces.source': controlId,
      'jakarta.faces.partial.execute': formId,
      'jakarta.faces.partial.render': formId,
    });
    let response;
    let bytes;
    try {
      response = await fetch(view.url, {
        method: 'POST',
        headers: {
          'Faces-Request': 'partial/ajax',
          'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
        },
        body: parameters.toString(),
      });
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      fail([diagnostic('transport-error', error.message)], null);
      return null;
    }

    if (response.status !== 200) {
      const evidenceId = store.saveEvidence('partial-response', {
        url: view.url, method: 'POST', status: response.status, source: controlId, formId,
        request: Object.fromEntries(parameters), result: 'http-error',
      }, bytes);
      evidence.push(evidenceId);
      fail([diagnostic('partial-status', `partial response returned HTTP ${response.status}`)], evidenceId);
      return null;
    }

    const parsed = parsePartialResponse(bytes);
    const evidenceId = store.saveEvidence('partial-response', {
      url: view.url, method: 'POST', status: response.status, source: controlId, formId,
      request: Object.fromEntries(parameters), result: parsed.kind,
    }, bytes);
    evidence.push(evidenceId);

    if (!parsed.ok) {
      if (parsed.redirect) {
        return { redirect: new URL(parsed.redirect, view.url).toString(), evidence: evidenceId };
      }
      fail(parsed.diagnostics, evidenceId);
      return null;
    }

    // Apply the entire response to a copy. If any operation cannot be applied
    // the copy is thrown away, so the live view never becomes half new/half old.
    const candidate = parseDocument(serializeDocument(view.document));
    let applied;
    try {
      applied = applyOperations(candidate, parsed.operations, formId);
    } catch (error) {
      const code = error instanceof ViewError ? error.code : 'apply-failed';
      fail([diagnostic(code, error.message)], evidenceId);
      return null;
    }
    view = { ...view, document: candidate };

    const viewEvidence = store.saveEvidence('applied-view', {
      url: view.url, response: evidenceId, source: controlId, formId,
      changed: [...applied.changed].sort(),
      viewStates: applied.viewStates,
    }, Buffer.from(serializeDocument(candidate)));
    views.push({ id: viewEvidence, source: controlId, changed: [...applied.changed].sort() });

    return { ...applied, evidence: evidenceId, viewEvidence, formId };
  }

  async function followRedirect(url, evidenceId) {
    redirects += 1;
    if (redirects > MAX_REDIRECTS) {
      fail([diagnostic('redirect-limit', 'server kept redirecting; old controls are not reused')], evidenceId);
      return false;
    }
    diagnostics.push(diagnostic('redirect-followed', `server moved the view to ${url}`, { evidence: evidenceId, url }));
    const next = await loadView(url, store, 'redirect-view', diagnostics);
    if (!next) return false;
    view = next;
    evidence.push(next.evidence);
    // A redirect starts a new view: element identities from the old page are gone.
    seenRows.clear();
    return true;
  }

  function markRecord(row, outcome) {
    const institution = readField(view.document, 'institution', outcome.changed);
    const contact = readField(view.document, 'contact', outcome.changed);
    // Both regions must come from this same response; otherwise a detail or
    // contact left over from an earlier expansion could be paired with the
    // new institution.
    const bothPresent = institution.present && contact.present
      && institution.value && contact.value
      && !placeholder(institution.value) && !placeholder(contact.value);
    const bothChanged = institution.region && contact.region
      && outcome.changed.has(institution.region) && outcome.changed.has(contact.region);
    if (!bothPresent || !bothChanged) {
      pending.push({
        row: row.id, institutionId: row.institutionId, reason: 'details-not-closed-together',
        institution: institution.value, contact: contact.value,
        regions: { institution: institution.region, contact: contact.region },
        evidence: outcome.evidence,
      });
      return;
    }
    collected.set(row.institutionId, {
      institution: institution.value,
      contact: contact.value,
      institutionId: row.institutionId,
      source: row.id,
      formId: outcome.formId,
      status: 'complete',
      evidence: outcome.evidence,
      view: outcome.viewEvidence,
    });
    // Only closed records reach the receipt store; pending fragments stay out
    // of the deliverable collection.
    store.put('institutions', row.institutionId, collected.get(row.institutionId));
  }

  // The loop repeats only after a redirect replaced the view and its controls,
  // so the round cap doubles as a guard against redirect cycles.
  rounds: for (let round = 0; round < MAX_ROUNDS && usable; round += 1) {
    if (!findById(view.document, source.sourceId)) {
      fail([diagnostic('missing-control', `search control ${source.sourceId} is not in the current view`)], null);
      break;
    }
    const searched = await post(source.sourceId);
    if (!searched) break;
    if (searched.redirect) {
      if (await followRedirect(searched.redirect, searched.evidence)) continue;
      break;
    }

    // Only rows surfaced by this search response are candidates; hidden
    // templates elsewhere in the document are not treated as results.
    const rows = institutionRows(view.document, searched.changed)
      .filter(row => !seenRows.has(row.id));
    if (!rows.length) break;

    let redirect = null;
    for (const row of rows) {
      if (!usable) break rounds;
      if (row.disabled) {
        seenRows.add(row.id);
        pending.push({
          row: row.id, institutionId: row.institutionId, reason: 'disabled', evidence: searched.evidence,
        });
        continue;
      }
      seenRows.add(row.id);
      const outcome = await post(row.id);
      if (!outcome) break rounds;
      if (outcome.redirect) { redirect = outcome; break; }
      markRecord(row, outcome);
    }

    if (redirect) {
      if (await followRedirect(redirect.redirect, redirect.evidence)) continue;
      break;
    }
    // One search round enumerates the surfaced rows. The loop only runs again
    // when a redirect replaced the view and its controls.
    break;
  }

  return {
    status: !usable ? 'incomplete' : (collected.size ? 'complete' : 'empty'),
    reason: failReason,
    records: records(),
    forms: formsOf(view.document).byId,
    pending,
    diagnostics,
    evidence,
    views,
    url: view.url,
  };
}

import { parse, parseFragment, serialize } from 'parse5';

export class ViewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ViewError';
    this.code = code;
  }
}

export function attribute(node, name) {
  return node?.attrs?.find(item => item.name === name)?.value;
}

export function hasAttribute(node, name) {
  return Boolean(node?.attrs?.some(item => item.name === name));
}

function setAttribute(node, name, value) {
  const existing = node.attrs.find(item => item.name === name);
  if (existing) existing.value = value;
  else node.attrs.push({ name, value });
}

export function walk(node, visit) {
  visit(node);
  for (const child of node.childNodes || []) walk(child, visit);
}

export function findById(root, id) {
  let found = null;
  walk(root, node => {
    if (!found && node.tagName && attribute(node, 'id') === id) found = node;
  });
  return found;
}

export function textContent(node) {
  if (node.nodeName === '#text') return node.value;
  return (node.childNodes || []).map(textContent).join('');
}

export function parseDocument(html) {
  return parse(html);
}

export function serializeDocument(document) {
  return serialize(document);
}

export function formsOf(document) {
  const order = [];
  const byId = {};
  walk(document, node => {
    if (node.tagName !== 'form') return;
    const key = attribute(node, 'id') || `form-${order.length}`;
    const fields = {};
    walk(node, field => {
      if (field.tagName === 'input' && attribute(field, 'name')) {
        fields[attribute(field, 'name')] = attribute(field, 'value') ?? '';
      }
    });
    order.push(key);
    byId[key] = fields;
  });
  return { order, byId };
}

export function formNode(document, formId) {
  return findById(document, formId) || null;
}

export function formOfControl(document, controlId) {
  const node = findById(document, controlId);
  for (let current = node; current; current = current.parentNode) {
    if (current.tagName === 'form') return current;
  }
  const prefix = controlId.includes(':') ? controlId.slice(0, controlId.indexOf(':')) : controlId;
  return formNode(document, prefix);
}

export function formFields(document, controlId) {
  const form = formOfControl(document, controlId);
  const fields = {};
  if (!form) return fields;
  walk(form, field => {
    if (field.tagName !== 'input' || !attribute(field, 'name')) return;
    const name = attribute(field, 'name');
    if (name === 'jakarta.faces.ViewState' || name === 'javax.faces.ViewState') return;
    // Checkboxes and radios only enter the submission when checked.
    const type = (attribute(field, 'type') || '').toLowerCase();
    if ((type === 'checkbox' || type === 'radio') && !hasAttribute(field, 'checked')) return;
    fields[name] = attribute(field, 'value') ?? '';
  });
  return fields;
}

export function viewStateOf(document, controlId) {
  const form = formOfControl(document, controlId);
  if (!form) return null;
  let value = null;
  walk(form, field => {
    if (value === null && field.tagName === 'input'
      && ['jakarta.faces.ViewState', 'javax.faces.ViewState'].includes(attribute(field, 'name'))) {
      value = attribute(field, 'value') ?? '';
    }
  });
  return value;
}

/**
 * Institution rows currently exposed in the view. When `changed` is given,
 * only rows that the applied response itself introduced or refreshed count;
 * that is a view over the response, not a scan of every hidden template the
 * page happens to ship.
 */
export function institutionRows(document, changed = null) {
  const rows = [];
  walk(document, node => {
    if (!node.tagName || attribute(node, 'data-institution') === undefined) return;
    let region = null;
    let touched = !changed;
    for (let current = node; current; current = current.parentNode) {
      const id = attribute(current, 'id');
      if (!id) continue;
      if (!region) region = id;
      if (changed && changed.has(id)) touched = true;
    }
    if (!touched) return;
    rows.push({
      id: attribute(node, 'id'),
      institutionId: attribute(node, 'data-institution'),
      disabled: hasAttribute(node, 'disabled'),
      region,
    });
  });
  return rows;
}

function regionIdOf(node) {
  for (let current = node; current; current = current.parentNode) {
    const id = attribute(current, 'id');
    if (id) return id;
  }
  return null;
}

/**
 * Read every node carrying data-field, in document order. A page can ship
 * hidden templates with the same field name as the live region, so callers
 * need to see all candidates before deciding which one is current.
 */
export function fields(document, fieldName) {
  const found = [];
  walk(document, node => {
    if (node.tagName && attribute(node, 'data-field') === fieldName) {
      found.push({ value: textContent(node).trim(), present: true, region: regionIdOf(node) });
    }
  });
  return found;
}

export function readField(document, fieldName, changed = null) {
  const candidates = fields(document, fieldName);
  const chosen = (changed && candidates.find(item => item.region && changed.has(item.region)))
    || candidates[0];
  return chosen || { value: '', present: false, region: null };
}

function idsWithin(node) {
  const ids = new Set();
  walk(node, item => {
    const id = attribute(item, 'id');
    if (id) ids.add(id);
  });
  return ids;
}

function adopt(parent, nodes, index) {
  for (const node of nodes) node.parentNode = parent;
  parent.childNodes.splice(index, 0, ...nodes);
}

function detach(node) {
  const parent = node.parentNode;
  if (!parent) return;
  const index = parent.childNodes.indexOf(node);
  if (index >= 0) parent.childNodes.splice(index, 1);
}

function viewStateFormId(operationId, submittingForm) {
  for (const suffix of ['jakarta.faces.ViewState', 'javax.faces.ViewState']) {
    if (operationId === suffix) return submittingForm;
    if (operationId.endsWith(':' + suffix)) return operationId.slice(0, -(suffix.length + 1));
  }
  return null;
}

function fragmentNodes(content) {
  const nodes = [...parseFragment(content).childNodes];
  // Region updates routinely carry indentation around their markup. Keep text
  // when the update really is text-only, but ignore layout whitespace when
  // element markup is present so the replacement stays a single region.
  if (!nodes.some(node => node.tagName)) return nodes;
  return nodes.filter(node => node.tagName || node.value.trim());
}

function applyUpdate(document, operation, changed) {
  const target = findById(document, operation.id);
  if (!target) throw new ViewError('missing-target', `update target ${operation.id} is not in the current view`);
  const nodes = fragmentNodes(operation.content);
  changed.add(operation.id);
  for (const node of nodes) for (const id of idsWithin(node)) changed.add(id);
  const single = nodes.length === 1 && nodes[0].tagName && attribute(nodes[0], 'id') === operation.id;
  if (single) {
    if (target.parentNode) {
      const index = target.parentNode.childNodes.indexOf(target);
      detach(target);
      adopt(target.parentNode, nodes, index < 0 ? target.parentNode.childNodes.length : index);
    } else {
      throw new ViewError('detached-target', `update target ${operation.id} has no parent view node`);
    }
  } else {
    for (const child of target.childNodes || []) child.parentNode = undefined;
    target.childNodes = [];
    adopt(target, nodes, 0);
  }
}

function applyInsert(document, operation, changed) {
  const reference = findById(document, operation.id);
  if (!reference || !reference.parentNode) {
    throw new ViewError('missing-target', `insert reference ${operation.id} is not in the current view`);
  }
  const nodes = fragmentNodes(operation.content);
  for (const node of nodes) for (const id of idsWithin(node)) changed.add(id);
  const siblings = reference.parentNode.childNodes;
  const index = operation.position === 'before' ? siblings.indexOf(reference) : siblings.indexOf(reference) + 1;
  adopt(reference.parentNode, nodes, index);
}

function applyAttributes(document, operation, changed) {
  const target = findById(document, operation.id);
  if (!target) throw new ViewError('missing-target', `attributes target ${operation.id} is not in the current view`);
  for (const attributeChange of operation.attributes) {
    setAttribute(target, attributeChange.name, attributeChange.value ?? '');
  }
  changed.add(operation.id);
}

function applyViewState(document, operation, submittingForm) {
  const formId = viewStateFormId(operation.id, submittingForm);
  if (!formId) throw new ViewError('unknown-view-state', `cannot locate the form for ${operation.id}`);
  const form = formNode(document, formId);
  if (!form) throw new ViewError('unknown-view-state-form', `ViewState update names unknown form ${formId}`);
  let field = null;
  walk(form, node => {
    if (field || node.tagName !== 'input') return;
    if (['jakarta.faces.ViewState', 'javax.faces.ViewState'].includes(attribute(node, 'name'))) field = node;
  });
  if (!field) {
    field = parseFragment('<input name="jakarta.faces.ViewState" value="">').childNodes[0];
    adopt(form, [field], form.childNodes.length);
  }
  setAttribute(field, 'value', operation.content.trim());
  return { formId, value: operation.content.trim() };
}

/**
 * Apply one partial response as a single atomic view change.
 *
 * `document` is mutated in place. Callers must discard it unless this returns
 * successfully, so a rejected response can never leave a half-applied view.
 */
export function applyOperations(document, operations, submittingForm) {
  const changed = new Set();
  const viewStates = [];
  for (const operation of operations) {
    if (operation.type === 'update') {
      if (viewStateFormId(operation.id, submittingForm)) {
        const state = applyViewState(document, operation, submittingForm);
        changed.add(operation.id);
        viewStates.push(state);
      } else {
        applyUpdate(document, operation, changed);
      }
    } else if (operation.type === 'delete') {
      const target = findById(document, operation.id);
      if (!target) throw new ViewError('missing-target', `delete target ${operation.id} is not in the current view`);
      detach(target);
      changed.add(operation.id);
    } else if (operation.type === 'insert') {
      applyInsert(document, operation, changed);
    } else if (operation.type === 'attributes') {
      applyAttributes(document, operation, changed);
    } else {
      throw new ViewError('unsupported-operation', `unsupported operation ${operation.type}`);
    }
  }
  return { changed, viewStates };
}

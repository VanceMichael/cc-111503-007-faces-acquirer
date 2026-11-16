import { SaxesParser } from 'saxes';

function diagnostic(code, message, extra = {}) {
  return { code, message, ...extra };
}

function collectText(node) {
  let value = '';
  for (const part of node.content) {
    if (part.type === 'text' || part.type === 'cdata') value += part.value;
    else value += collectText(part);
  }
  return value;
}

function trimmedText(node) {
  return collectText(node).trim();
}

/**
 * Parse a JSF partial-response document without executing anything it contains.
 *
 * The whole document is validated before any operation is returned. A DTD,
 * malformed/truncated XML, an <eval> element, an <error> element, a redirect or
 * an unknown directive makes the response unusable as a view change.
 */
export function parsePartialResponse(bytes) {
  const source = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
  const root = { name: '#document', attrs: {}, content: [] };
  const stack = [root];
  let parseError = null;
  let sawDoctype = false;

  const parser = new SaxesParser({ xmlns: false });
  parser.on('doctype', () => { sawDoctype = true; });
  parser.on('opentag', node => {
    const element = { type: 'element', name: node.name, attrs: { ...node.attributes }, content: [] };
    stack[stack.length - 1].content.push(element);
    stack.push(element);
  });
  parser.on('closetag', () => { if (stack.length > 1) stack.pop(); });
  parser.on('text', value => stack[stack.length - 1].content.push({ type: 'text', value }));
  parser.on('cdata', value => stack[stack.length - 1].content.push({ type: 'cdata', value }));
  parser.on('error', error => { if (!parseError) parseError = error.message; });

  try {
    parser.write(source).close();
  } catch (error) {
    if (!parseError) parseError = error.message;
  }

  const diagnostics = [];
  if (sawDoctype) diagnostics.push(diagnostic('dtd-prohibited', 'partial response contains a DTD'));
  if (parseError) diagnostics.push(diagnostic('xml-incomplete', parseError));

  const topLevel = root.content.filter(part => part.type !== 'text' || part.value.trim());
  if (!parseError && (topLevel.length !== 1 || topLevel[0].type !== 'element')) {
    diagnostics.push(diagnostic('xml-incomplete', 'partial response must have exactly one root element'));
  }
  if (diagnostics.length) {
    return { kind: 'invalid', ok: false, operations: [], diagnostics };
  }

  const partial = topLevel[0];
  if (partial.name !== 'partial-response') {
    diagnostics.push(diagnostic('unexpected-root', `unexpected root element ${partial.name}`));
    return { kind: 'invalid', ok: false, operations: [], diagnostics };
  }

  let error = null;
  let redirect = null;
  let sawChanges = false;
  let rejection = null;
  const operations = [];
  const reject = item => { if (!rejection) rejection = item; };

  // Look for an error or redirect first: when either is present this response
  // does not describe a usable change, so an empty <changes> must not be
  // reported as the primary problem.
  const hasErrorElement = partial.content.some(part => part.type === 'element' && part.name === 'error');
  const hasRedirectElement = partial.content.some(part => part.type === 'element' && part.name === 'redirect');

  for (const child of partial.content) {
    if (child.type !== 'element') continue;
    if (child.name === 'changes') {
      sawChanges = true;
      for (const operation of child.content) {
        if (operation.type !== 'element') continue;
        const id = operation.attrs.id;
        if (operation.name === 'update') {
          if (!id) reject(diagnostic('missing-target', 'update without id'));
          else operations.push({ type: 'update', id, content: collectText(operation) });
        } else if (operation.name === 'delete') {
          if (!id) reject(diagnostic('missing-target', 'delete without id'));
          else operations.push({ type: 'delete', id });
        } else if (operation.name === 'insert') {
          for (const side of operation.content) {
            if (side.type !== 'element') continue;
            if (side.name !== 'before' && side.name !== 'after') {
              reject(diagnostic('unsupported-directive', `unsupported insert directive ${side.name}`));
              continue;
            }
            if (!side.attrs.id) { reject(diagnostic('missing-target', 'insert without id')); continue; }
            operations.push({
              type: 'insert', position: side.name, id: side.attrs.id, content: collectText(side),
            });
          }
        } else if (operation.name === 'attributes') {
          if (!id) { reject(diagnostic('missing-target', 'attributes without id')); continue; }
          const attributes = [];
          for (const attribute of operation.content) {
            if (attribute.type !== 'element') continue;
            if (attribute.name !== 'attribute' || !attribute.attrs.name) {
              reject(diagnostic('unsupported-directive', 'unsupported attributes directive'));
              continue;
            }
            attributes.push({ name: attribute.attrs.name, value: attribute.attrs.value ?? '' });
          }
          operations.push({ type: 'attributes', id, attributes });
        } else if (operation.name === 'eval') {
          reject(diagnostic('eval-rejected', 'partial response contains eval; the change was not applied'));
        } else {
          reject(diagnostic('unsupported-directive', `unsupported change directive ${operation.name}`));
        }
      }
      if (!operations.length && !rejection && !hasErrorElement && !hasRedirectElement) {
        reject(diagnostic('empty-response', 'partial response contains no change operations'));
      }
    } else if (child.name === 'redirect') {
      if (!child.attrs.url) reject(diagnostic('redirect-without-url', 'redirect without url'));
      else redirect = child.attrs.url;
    } else if (child.name === 'error') {
      const values = {};
      for (const part of child.content) {
        if (part.type === 'element' && (part.name === 'error-name' || part.name === 'error-message')) {
          values[part.name] = trimmedText(part);
        }
      }
      error = { name: values['error-name'] || 'unknown', message: values['error-message'] || '' };
    } else {
      reject(diagnostic('unsupported-directive', `unsupported partial-response element ${child.name}`));
    }
  }

  if (rejection) {
    const kind = rejection.code === 'eval-rejected' ? 'eval' : 'invalid';
    return { kind, ok: false, operations: [], diagnostics: [...diagnostics, rejection] };
  }
  if (error) {
    diagnostics.push(diagnostic('partial-error', error.message || error.name, { name: error.name }));
    return { kind: 'error', ok: false, operations: [], error, diagnostics };
  }
  if (redirect) {
    diagnostics.push(diagnostic('redirect', `partial response redirects to ${redirect}`, { url: redirect }));
    return { kind: 'redirect', ok: false, operations: [], redirect, diagnostics };
  }
  if (!sawChanges) {
    diagnostics.push(diagnostic('empty-response', 'partial response has no changes'));
    return { kind: 'invalid', ok: false, operations: [], diagnostics };
  }
  return { kind: 'ok', ok: true, operations, diagnostics };
}

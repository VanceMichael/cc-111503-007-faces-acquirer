import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePartialResponse } from '../src/partial.mjs';

test('a complete response is parsed into one atomic operation list', () => {
  const parsed = parsePartialResponse(`<partial-response><changes>
<update id="details"><![CDATA[<section id="details">A</section>]]></update>
<delete id="contacts"/>
<insert><after id="details"><![CDATA[<section id="contacts">B</section>]]></after></insert>
<attributes id="directory:row:siteA"><attribute name="disabled" value="disabled"/></attributes>
<update id="directory:jakarta.faces.ViewState"><![CDATA[d3]]></update>
</changes></partial-response>`);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.operations.map(operation => operation.type),
    ['update', 'delete', 'insert', 'attributes', 'update']);
  assert.deepEqual(parsed.operations[2],
    { type: 'insert', position: 'after', id: 'details', content: '<section id="contacts">B</section>' });
});

for (const [name, document, code] of [
  ['a DTD', '<!DOCTYPE partial-response><partial-response><changes/></partial-response>', 'dtd-prohibited'],
  ['an error', '<partial-response><error><error-name>x</error-name></error></partial-response>', 'partial-error'],
  ['eval', '<partial-response><changes><eval>x()</eval></changes></partial-response>', 'eval-rejected'],
  ['an unknown directive', '<partial-response><changes><script>x</script></changes></partial-response>', 'unsupported-directive'],
  ['a wrong root', '<html><body>login</body></html>', 'unexpected-root'],
]) {
  test(`${name} rejects the whole response`, () => {
    const parsed = parsePartialResponse(document);
    assert.equal(parsed.ok, false);
    assert.deepEqual(parsed.operations, []);
    assert.equal(parsed.diagnostics[0].code, code);
  });
}

test('a truncated response is reported as incomplete, not partly applied', () => {
  const document = '<partial-response><changes><update id="details"><![CDATA[<section id="details">A';
  const parsed = parsePartialResponse(document);
  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.operations, []);
  assert.equal(parsed.diagnostics[0].code, 'xml-incomplete');
});

import { serve, body } from './http.mjs';

const initial = `<!doctype html><html><body>
<form id="directory"><input name="jakarta.faces.ViewState" value="d1"><input name="city" value="C1">
<button id="directory:search">search</button><section id="matches">not searched</section>
<section id="details"><span data-field="institution">not selected</span></section>
<section id="contacts"><span data-field="contact">not selected</span></section></form>
<form id="other"><input name="jakarta.faces.ViewState" value="o1"></form>
</body></html>`;

export async function fixture(scenario = 'normal') {
  const requests = []; let viewState = 'd1';
  const source = await serve(async (request, response) => {
    if (request.method === 'GET') {
      viewState = 'd1'; response.writeHead(200, { 'content-type': 'text/html' }); return response.end(initial);
    }
    const parameters = new URLSearchParams(await body(request)); requests.push(Object.fromEntries(parameters));
    if (request.headers['faces-request'] !== 'partial/ajax' || parameters.get('jakarta.faces.ViewState') !== viewState) {
      response.writeHead(409); return response.end('wrong view state');
    }
    response.writeHead(200, { 'content-type': 'text/xml' });
    if (viewState === 'd1') {
      if (parameters.get('jakarta.faces.source') !== 'directory:search') {
        return response.end('<partial-response><error><error-name>search-first</error-name></error></partial-response>');
      }
      viewState = 'd2';
      return response.end(`<partial-response><changes>
<update id="matches"><![CDATA[<section id="matches"><button id="directory:row:siteA" data-institution="siteA">Center A</button></section>]]></update>
<update id="directory:jakarta.faces.ViewState"><![CDATA[d2]]></update>
<update id="other:jakarta.faces.ViewState"><![CDATA[o2]]></update>
</changes></partial-response>`);
    }
    if (parameters.get('jakarta.faces.source') !== 'directory:row:siteA') {
      return response.end('<partial-response><error><error-name>select-current-row</error-name></error></partial-response>');
    }
    viewState = 'd3';
    const contacts = scenario === 'mutations'
      ? `<delete id="contacts"/><insert><after id="details"><![CDATA[<section id="contacts"><span data-field="contact">Desk A</span></section>]]></after></insert>
<attributes id="directory:row:siteA"><attribute name="disabled" value="disabled"/></attributes>`
      : `<update id="contacts"><![CDATA[<section id="contacts"><span data-field="contact">Desk A</span></section>]]></update>`;
    const updates = `<update id="details"><![CDATA[<section id="details"><span data-field="institution">Center A</span></section>]]></update>
${contacts}<update id="directory:jakarta.faces.ViewState"><![CDATA[d3]]></update>
<update id="other:jakarta.faces.ViewState"><![CDATA[o3]]></update>`;
    if (scenario === 'redirect') return response.end('<partial-response><redirect url="/fresh"/></partial-response>');
    if (scenario === 'error') return response.end('<partial-response><error><error-name>expired</error-name><error-message>reload</error-message></error></partial-response>');
    const extra = scenario === 'eval' ? '<eval>doSomething()</eval>' : '';
    const xml = `<partial-response><changes>${updates}${extra}</changes></partial-response>`;
    response.end(scenario === 'truncated' ? xml.slice(0, -30) : xml);
  });
  return { ...source, path: '/directory', formId: 'directory', sourceId: 'directory:search', requests };
}

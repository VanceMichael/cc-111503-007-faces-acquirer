import { serve, body } from './http.mjs';

const initial = `<!doctype html><html><body>
<form id="directory"><input name="jakarta.faces.ViewState" value="d1"><button id="directory:open">open</button>
<section id="details"><span data-field="institution">not selected</span></section>
<section id="contacts"><span data-field="contact">not selected</span></section></form>
<form id="other"><input name="jakarta.faces.ViewState" value="o1"></form>
</body></html>`;

export async function fixture(scenario = 'normal') {
  const requests = [];
  const source = await serve(async (request, response) => {
    if (request.method === 'GET') { response.writeHead(200, { 'content-type': 'text/html' }); return response.end(initial); }
    const parameters = new URLSearchParams(await body(request)); requests.push(Object.fromEntries(parameters));
    if (request.headers['faces-request'] !== 'partial/ajax' || parameters.get('jakarta.faces.ViewState') !== 'd1') {
      response.writeHead(409); return response.end('wrong view state');
    }
    response.writeHead(200, { 'content-type': 'text/xml' });
    const updates = `<update id="details"><![CDATA[<section id="details"><span data-field="institution">Center A</span></section>]]></update>
<update id="contacts"><![CDATA[<section id="contacts"><span data-field="contact">Desk A</span></section>]]></update>
<update id="directory:jakarta.faces.ViewState"><![CDATA[d2]]></update>
<update id="other:jakarta.faces.ViewState"><![CDATA[o2]]></update>`;
    if (scenario === 'redirect') return response.end('<partial-response><redirect url="/fresh"/></partial-response>');
    if (scenario === 'error') return response.end('<partial-response><error><error-name>expired</error-name><error-message>reload</error-message></error></partial-response>');
    const extra = scenario === 'eval' ? '<eval>doSomething()</eval>' : '';
    const xml = `<partial-response><changes>${updates}${extra}</changes></partial-response>`;
    response.end(scenario === 'truncated' ? xml.slice(0, -30) : xml);
  });
  return { ...source, path: '/directory', formId: 'directory', sourceId: 'directory:open', requests };
}


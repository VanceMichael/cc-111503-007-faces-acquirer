import { fixture } from './portal.mjs';
import { preview, collect } from './intake.mjs';
import { Inbox } from './store.mjs';

const source = await fixture('normal');
const store = new Inbox();
try {
  const previewResult = await preview(source, store);
  const collection = await collect(source, store);
  const evidence = store.evidence().map(item => ({
    ...item,
    body: store.getEvidence(item.id).body.toString('utf8'),
  }));
  console.log(JSON.stringify({
    preview: previewResult,
    collection: {
      status: collection.status,
      records: collection.records,
      forms: collection.forms,
      pending: collection.pending,
      diagnostics: collection.diagnostics,
      views: collection.views,
    },
    evidence,
  }, null, 2));
} finally { store.close(); await source.close(); }

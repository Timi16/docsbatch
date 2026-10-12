'use strict';
const { route, gemini, httpError, normalize } = require('./_lib');

const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

// Poll a batch job. When it has finished, the answers come back in the same response.
module.exports = route(
  async (req) => {
    const name = String((req.query && req.query.name) || '');
    if (!/^batches\/[A-Za-z0-9_-]+$/.test(name)) throw httpError(400, 'Bad batch name.');

    const { data: d } = await gemini(`/v1beta/${name}`);
    const rawState = (d.metadata && d.metadata.state) || d.state || '';
    const stateName = String(rawState).replace(/^(JOB|BATCH)_STATE_/, '');
    const terminal = /^(SUCCEEDED|FAILED|CANCELLED|EXPIRED)$/.test(stateName);

    const bs = (d.metadata && d.metadata.batchStats) || d.batchStats || null;
    const stats = bs
      ? {
          total: num(bs.requestCount),
          ok: num(bs.successfulRequestCount),
          failed: num(bs.failedRequestCount),
          pending: num(bs.pendingRequestCount),
        }
      : null;

    let results = null;
    let error = null;
    if (stateName === 'SUCCEEDED') {
      const out = d.response || d.dest || (d.metadata && d.metadata.output) || {};
      let arr = out.inlinedResponses;
      if (arr && !Array.isArray(arr)) arr = arr.inlinedResponses;
      if (Array.isArray(arr)) {
        results = arr.map((x, i) => ({
          key: (x.metadata && x.metadata.key) || null,
          index: i,
          ...(x.response ? normalize(x.response) : { error: (x.error && x.error.message) || 'This request failed.' }),
        }));
      } else {
        error = 'The job finished but the answers were not returned inline. Try a smaller batch.';
      }
    } else if (stateName === 'FAILED') {
      error = (d.error && d.error.message) || 'The batch job failed.';
    } else if (stateName === 'EXPIRED') {
      error = 'The job expired after 48 hours. Run it again (maybe with fewer files).';
    }

    return { name, stateName, terminal, stats, results, error, createTime: (d.metadata && d.metadata.createTime) || null };
  },
  { method: 'GET' }
);

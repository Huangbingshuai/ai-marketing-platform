import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  safeDiagnostic,
  safeMechanicalError,
  taskIds,
  readDiagnostics,
  DIAGNOSTIC_SQL,
} from './inspect-customized-production-failures.mjs';
const id = 'bfbadb51-018f-44bf-b0b3-32821096bd93';
test('only explicit bounded UUID task arguments are accepted', () => {
  assert.deepEqual(taskIds(['--task', id, '--task', id]), [id]);
  for (const args of [[], ['--task', 'invalid'], ['--apply', id], ['--task', id, '--task']])
    assert.throws(() => taskIds(args));
});
test('diagnostic never emits body, credentials, URLs, raw unknown errors or audit prose', () => {
  const secret = 'sk-private-secret-1234567890123456789012345';
  const url = 'https://private.invalid/file?signature=sensitive';
  const value = safeDiagnostic({
    id,
    operation: 'PROMPT',
    status: 'FAILED',
    input: { targetId: 'clip' },
    scope: { CLIP: ['clip'], SHOT: ['shot'] },
    steps: [{ id: 'REVIEW', status: 'FAILED', content: secret }],
    mechanical_errors: { audit: secret + ' ' + url },
    mechanical_issue_sets: { auditCorrected: [secret + ' ' + url] },
    mechanical_recovery: {
      version: 1,
      epoch: 2,
      phase: 'audit',
      historyCount: 2,
      history: [{ candidate: secret }],
    },
    audits: {
      auditCorrected: {
        present: true,
        summary: secret,
        findings: [
          {
            id: 'f1',
            severity: 'ERROR',
            repairKind: 'FIELDS',
            impact: url,
            evidence: [{ entity: 'PROMPT', id: 'clip', field: 'content' }],
          },
        ],
        quotes: [{ issueId: 'f1', length: 12, matchesPrompt: true, excerpt: secret }],
      },
    },
    render: { providerTaskId: url },
    systemPrompt: secret,
  });
  const text = JSON.stringify(value);
  assert.ok(!text.includes(secret) && !text.includes(url) && !text.includes('signature='));
  assert.equal(value.audits.auditCorrected.quotes[0].matchesPrompt, true);
  assert.equal(value.audits.auditCorrected.findings[0].evidence[0].idInSnapshot, true);
  assert.deepEqual(value.mechanicalRecovery, {
    version: 1,
    epoch: 2,
    phase: 'audit',
    historyCount: 2,
  });
  assert.equal(value.mechanicalIssueSets.auditCorrected[0].code, 'UNCLASSIFIED_VALIDATION');
});
test('mechanical errors retain only classified reason and safe evidence identity/path', () => {
  assert.equal(
    safeMechanicalError('initial review must not invent previous findings').code,
    'INITIAL_RESOLUTIONS',
  );
  assert.deepEqual(
    safeMechanicalError('review evidence must select an actual field: unknown SHOT:REF5'),
    { code: 'EVIDENCE_ID_OR_FIELD', entity: 'SHOT', id: 'REF5', field: null },
  );
  const report = safeDiagnostic({
    mechanical_errors: {
      auditCorrected: 'duplicate prompt review quote for the same finding and excerpt',
    },
    corrections: { audit: 1 },
  });
  assert.deepEqual(report.mechanicalErrors.auditCorrected, { code: 'DUPLICATE_QUOTE_PAIR' });
  assert.equal(report.corrections.audit, 1);
});
test('database read is scoped, parameterized, readonly and rolled back, including failures', async () => {
  for (const fail of [false, true]) {
    const queries = [];
    const client = {
      query: async (sql, args) => {
        queries.push([sql, args]);
        if (sql === DIAGNOSTIC_SQL && fail) throw Error('controlled');
        return { rows: [] };
      },
    };
    if (fail) await assert.rejects(readDiagnostics(client, [id]));
    else assert.deepEqual(await readDiagnostics(client, [id]), []);
    assert.equal(queries[0][0], 'BEGIN READ ONLY');
    assert.equal(queries.at(-1)[0], 'ROLLBACK');
    assert.deepEqual(queries.find(([sql]) => sql === DIAGNOSTIC_SQL)[1], [[id]]);
    assert.ok(DIAGNOSTIC_SQL.includes('t.id=ANY($1::uuid[])'));
  }
});

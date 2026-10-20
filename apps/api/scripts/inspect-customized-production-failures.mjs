// Read-only, explicit task IDs, no model/API calls. Never emit prompts, URLs or credentials.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const phases = ['audit', 'auditCorrected', 'recheck', 'recheckCorrected'];
const fields = new Set([
  'content',
  'assetIds',
  'visual',
  'information',
  'startState',
  'endState',
  'durationSeconds',
  'title',
  'shotType',
  'cameraMovement',
  'audio',
  'atmosphere',
  'bindings',
  'framing',
  'angle',
  'sourceEventIds',
  'sceneId',
  'eventIds',
  'shotIds',
  'text',
  'kind',
  'speaker',
  'sourceRef',
  'parts',
  'setting',
  'spatialBaseline',
  'sceneAssetId',
  'explanation',
  'estimatedSpeechSeconds',
  'uncertainty',
]);
const arraySql = (v) => `CASE WHEN jsonb_typeof(${v})='array' THEN ${v} ELSE '[]'::jsonb END`;
const auditSql = (key) => {
  const a = `t.output->'${key}'`,
    text = key.startsWith('recheck')
      ? "COALESCE(t.output->'revised'->>'content',t.output->'value'->>'content','')"
      : "COALESCE(t.output->'value'->>'content',t.output->'promptCandidate'->>'content','')";
  return `jsonb_build_object('present',COALESCE(t.output ? '${key}',false),
    'dimensions',(SELECT jsonb_agg(x->>'dimension') FROM jsonb_array_elements(${arraySql(`${a}->'checks'`)}) x),
    'findings',(SELECT jsonb_agg(jsonb_build_object('id',x->'id','severity',x->'severity','category',x->'category',
      'repairKind',x->'repairKind','evidence',x->'evidence','affectedShotIds',x->'affectedShotIds','affectedClipIds',x->'affectedClipIds'))
      FROM jsonb_array_elements(${arraySql(`${a}->'findings'`)}) x),
    'resolutions',(SELECT jsonb_agg(jsonb_build_object('issueId',x->'issueId','status',x->'status','evidence',x->'evidence'))
      FROM jsonb_array_elements(${arraySql(`${a}->'resolutions'`)}) x),
    'quotes',(SELECT jsonb_agg(jsonb_build_object('issueId',x->'issueId','length',length(x->>'excerpt'),
      'matchesPrompt',length(COALESCE(x->>'excerpt',''))>0 AND strpos(${text},x->>'excerpt')>0))
      FROM jsonb_array_elements(${arraySql(`${a}->'promptEvidence'`)}) x))`;
};

export const DIAGNOSTIC_SQL = `SELECT t.id,t."projectId",t."workflowRunId",t.operation,t.status,t."createdAt",t."updatedAt",
  jsonb_build_object('strategyVersion',t."inputSnapshot"->'strategyVersion','promptWorkflowVersion',t."inputSnapshot"->'promptWorkflowVersion',
    'targetId',t."inputSnapshot"->'target'->'id','renderClipId',t."inputSnapshot"->'videoRender'->'clipId') AS input,
  (SELECT jsonb_agg(jsonb_build_object('id',s->'id','status',s->'status')) FROM jsonb_array_elements(${arraySql('t.steps')}) s) AS steps,
  t.output->'mechanicalErrors' AS mechanical_errors,t.output->'corrections' AS corrections,
  t.output->'mechanicalIssueSets' AS mechanical_issue_sets,
  jsonb_build_object('version',t.output->'mechanicalRecovery'->'version',
    'epoch',t.output->'mechanicalRecovery'->'epoch','phase',t.output->'mechanicalRecovery'->'phase',
    'historyCount',jsonb_array_length(${arraySql("t.output->'mechanicalRecovery'->'history'")})) AS mechanical_recovery,
  t.output->>'failureReason' AS failure_reason,
  jsonb_build_object('providerTaskId',t.output->'providerTaskId','createStarted',t.output->'createStarted',
    'createRejected',t.output->'createRejected','rateLimited',t.output->'rateLimited') AS render,
  jsonb_build_object(${phases.map((k) => `'${k}',${auditSql(k)}`).join(',')}) AS audits,
  jsonb_build_object(${[
    ['SHOT', 'shots'],
    ['CLIP', 'clips'],
    ['SCENE', 'scenes'],
    ['CUE', 'cues'],
    ['EVENT', 'events'],
    ['SOURCE', 'sourceUnits'],
  ]
    .map(
      ([kind, key]) =>
        `'${kind}',jsonb_path_query_array(COALESCE(t."inputSnapshot"->'document'->'videoPlan','{}'::jsonb),'$.${key}[*].id')`,
    )
    .join(',')}) AS scope,
  NOT EXISTS(SELECT 1 FROM jsonb_array_elements(${arraySql('t."inputSnapshot"->\'sources\'')}) s
    WHERE NOT EXISTS(SELECT 1 FROM working_artifacts a WHERE a."projectId"=t."projectId" AND a."workflowRunId"=t."workflowRunId"
      AND a.id::text=s->>'id' AND a.revision::text=s->>'revision' AND a."contentHash"=s->>'hash' AND a.freshness='CURRENT')) AS sources_current,
  COALESCE((SELECT n.revision FROM workflow_node_states n WHERE n."projectId"=t."projectId" AND n."workflowRunId"=t."workflowRunId"
    AND n."nodeId"='CUSTOMIZED_PRODUCTION_DRAFT'),0)::text=t."inputSnapshot"->>'draftRevision' AS draft_matches,
  EXISTS(SELECT 1 FROM customized_production_tasks other WHERE other."projectId"=t."projectId" AND other."workflowRunId"=t."workflowRunId"
    AND other.id<>t.id AND other.status IN ('QUEUED','RUNNING')) AS another_active
  FROM customized_production_tasks t WHERE t.id=ANY($1::uuid[]) AND t.operation IN ('PROMPT','RENDER') ORDER BY t."createdAt"`;

const list = (v) => (Array.isArray(v) ? v : []);
const enumValue = (v, allowed) => (allowed.includes(v) ? v : null);
const digest = (v) => createHash('sha256').update(String(v)).digest('hex').slice(0, 12);
function safeId(v, known = new Set()) {
  if (typeof v !== 'string') return null;
  if (
    !/^(?:sk-|AKIA|Bearer|eyJ)/.test(v) &&
    (uuid.test(v) ||
      /^REF\d+$/.test(v) ||
      (known.has(v) && /^[\w-]{1,200}$/.test(v)) ||
      /^[A-Za-z][\w-]{0,31}$/.test(v))
  )
    return v;
  return `[opaque:${digest(v)}]`;
}

export function safeMechanicalError(value, known = new Set()) {
  const text = typeof value === 'string' ? value : '';
  const exact = [
    ['review must check all seven actual dimensions', 'DIMENSIONS'],
    ['duplicate finding IDs', 'DUPLICATE_FINDINGS'],
    ['review refers to another candidate', 'AFFECTED_IDS'],
    ['initial review must not invent previous findings', 'INITIAL_RESOLUTIONS'],
    ['recheck must resolve every original error exactly once', 'RESOLUTION_IDS'],
    ['prompt evidence must reference actual content', 'PROMPT_EVIDENCE_TARGET'],
    [
      'review excerpt must be a verbatim quote from current prompt.content',
      'QUOTE_REFERENCE_VALIDATION',
    ],
    ['duplicate prompt review quote for the same finding and excerpt', 'DUPLICATE_QUOTE_PAIR'],
    ['prompt review quote refers to an unknown finding', 'QUOTE_FINDING_UNKNOWN'],
    ['every prompt finding needs its exact current prompt.content excerpt', 'QUOTE_MISSING'],
  ];
  for (const [prefix, code] of exact) if (text.startsWith(prefix)) return { code };
  if (text.startsWith('review evidence must select an actual field:')) {
    const match = text.match(/(?:unknown )?([A-Z]+):([\w-]+)(?:\.([A-Za-z_][\w]*))?/);
    return {
      code: 'EVIDENCE_ID_OR_FIELD',
      entity: match?.[1] ?? null,
      id: safeId(match?.[2], known),
      field: fields.has(match?.[3]) ? match[3] : null,
    };
  }
  return { code: 'UNCLASSIFIED_VALIDATION', length: text.length, fingerprint: digest(text) };
}

export function safeDiagnostic(row) {
  const known = new Set(Object.values(row.scope ?? {}).flatMap(list));
  for (const id of [row.input?.targetId, row.input?.renderClipId])
    if (typeof id === 'string') known.add(id);
  const evidence = (e) => ({
    entity: enumValue(e?.entity, [
      'PROMPT',
      'SHOT',
      'CLIP',
      'SCENE',
      'CUE',
      'EVENT',
      'SOURCE',
      'TIMING',
    ]),
    id: safeId(e?.id, known),
    field: fields.has(e?.field) ? e.field : null,
    idInSnapshot:
      e?.entity === 'PROMPT'
        ? e.id === row.input?.targetId
        : e?.entity === 'TIMING'
          ? null
          : list(row.scope?.[e?.entity]).includes(e?.id),
  });
  const audits = Object.fromEntries(
    phases.map((key) => {
      const a = row.audits?.[key] ?? {};
      return [
        key,
        {
          present: a.present === true,
          dimensions: list(a.dimensions).map((v) =>
            enumValue(v, [
              '原稿兑现',
              '时间容量',
              '镜头表达',
              '产品事实',
              '动作与空间',
              '素材绑定',
              '模型能力',
            ]),
          ),
          findings: list(a.findings).map((f) => ({
            id: safeId(f.id, known),
            severity: enumValue(f.severity, ['ERROR', 'WARNING']),
            category: enumValue(f.category, [
              'FACT',
              'COVERAGE',
              'CAPACITY',
              'STATE',
              'SPACE',
              'SHOT_STRUCTURE',
              'BINDING',
              'CAPABILITY',
            ]),
            repairKind: enumValue(f.repairKind, ['FIELDS', 'STRUCTURE', 'INPUT']),
            evidence: list(f.evidence).map(evidence),
            affectedShotIds: list(f.affectedShotIds).map((id) => ({
              id: safeId(id, known),
              inSnapshot: list(row.scope?.SHOT).includes(id),
            })),
            affectedClipIds: list(f.affectedClipIds).map((id) => ({
              id: safeId(id, known),
              inSnapshot: list(row.scope?.CLIP).includes(id),
            })),
          })),
          resolutions: list(a.resolutions).map((v) => ({
            issueId: safeId(v.issueId, known),
            status: enumValue(v.status, ['RESOLVED', 'PARTIAL', 'UNRESOLVED']),
            evidence: list(v.evidence).map(evidence),
          })),
          quotes: list(a.quotes).map((q) => ({
            issueId: safeId(q.issueId, known),
            length: Number.isInteger(q.length) ? q.length : null,
            matchesPrompt: q.matchesPrompt === true,
          })),
        },
      ];
    }),
  );
  const keys =
    /^(audit|promptCandidate|revised|recheck|scopedRecheck|repairCandidate|directorCandidate|batch\d+)(Corrected)?$/;
  return {
    id: safeId(row.id),
    projectId: safeId(row.projectId),
    workflowRunId: safeId(row.workflowRunId),
    operation: enumValue(row.operation, ['PROMPT', 'RENDER']),
    status: enumValue(row.status, ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']),
    input: {
      strategyVersion: /^\d{4}-\d{2}-\d{2}-capacity-clips\.\d+$/.test(row.input?.strategyVersion)
        ? row.input.strategyVersion
        : null,
      promptWorkflowVersion: [2, 3].includes(row.input?.promptWorkflowVersion)
        ? row.input.promptWorkflowVersion
        : null,
      targetId: safeId(row.input?.targetId, known),
      renderClipId: safeId(row.input?.renderClipId, known),
    },
    steps: list(row.steps).map((s) => ({
      id: enumValue(s.id, ['SNAPSHOT', 'PLAN', 'GENERATE', 'REVIEW', 'REPAIR', 'SAVE']),
      status: enumValue(s.status, ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED']),
    })),
    mechanicalErrors: Object.fromEntries(
      Object.entries(row.mechanical_errors ?? {})
        .filter(([k]) => keys.test(k))
        .map(([k, v]) => [k, safeMechanicalError(v, known)]),
    ),
    mechanicalIssueSets: Object.fromEntries(
      Object.entries(row.mechanical_issue_sets ?? {})
        .filter(([k]) => keys.test(k))
        .map(([k, v]) => [k, list(v).map((issue) => safeMechanicalError(issue, known))]),
    ),
    mechanicalRecovery: {
      version: row.mechanical_recovery?.version === 1 ? 1 : null,
      epoch:
        Number.isSafeInteger(row.mechanical_recovery?.epoch) && row.mechanical_recovery.epoch > 0
          ? row.mechanical_recovery.epoch
          : null,
      phase: enumValue(row.mechanical_recovery?.phase, ['audit', 'recheck']),
      historyCount:
        Number.isSafeInteger(row.mechanical_recovery?.historyCount) &&
        row.mechanical_recovery.historyCount >= 0
          ? row.mechanical_recovery.historyCount
          : null,
    },
    corrections: Object.fromEntries(
      Object.entries(row.corrections ?? {}).filter(
        ([k, v]) => keys.test(k) && Number.isInteger(v) && v >= 0 && v <= 10,
      ),
    ),
    failureReason: enumValue(row.failure_reason, [
      'INVALID_CANDIDATE',
      'REVIEW_UNRESOLVED',
      'REQUEST_LIMIT',
      'ASSET_INPUT_GAP',
      'DURATION_CAPACITY_CONFLICT',
      'SOURCE_CONSTRAINT_CONFLICT',
    ]),
    render: {
      providerTaskId: safeId(row.render?.providerTaskId),
      createStarted: row.render?.createStarted === true,
      createRejected: row.render?.createRejected === true,
      rateLimited: row.render?.rateLimited === true,
    },
    retryChecks: {
      sourcesCurrent: row.sources_current === true,
      draftMatches: row.draft_matches === true,
      anotherActive: row.another_active === true,
    },
    audits,
  };
}

export function taskIds(args) {
  if (
    !args.length ||
    args.length > 16 ||
    args.length % 2 ||
    args.some((v, i) => (i % 2 === 0 ? v !== '--task' : !uuid.test(v)))
  )
    throw new Error('INVALID_TASK_ARGUMENTS');
  return [...new Set(args.filter((_, i) => i % 2 === 1))];
}
export async function readDiagnostics(client, ids) {
  await client.query('BEGIN READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await client.query(DIAGNOSTIC_SQL, [ids]);
    return result.rows.map(safeDiagnostic);
  } finally {
    await client.query('ROLLBACK');
  }
}
async function main() {
  const ids = taskIds(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL_REQUIRED');
  const require = createRequire(new URL('../package.json', import.meta.url));
  const { Client } = require('pg');
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
    application_name: 'customized-failure-readonly',
  });
  try {
    await client.connect();
    process.stdout.write(
      JSON.stringify({ tasks: await readDiagnostics(client, ids) }, null, 2) + '\n',
    );
  } finally {
    await client.end();
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  main().catch((error) => {
    const allowed = ['INVALID_TASK_ARGUMENTS', 'DATABASE_URL_REQUIRED'];
    process.stderr.write(
      JSON.stringify({
        error: allowed.includes(error.message) ? error.message : 'DIAGNOSTIC_READ_FAILED',
        databaseCode: /^[A-Z0-9]{5}$/.test(error.code ?? '') ? error.code : null,
      }) + '\n',
    );
    process.exitCode = 1;
  });

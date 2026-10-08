import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';

const base = [
  'workflow_runs',
  'workflow_node_states',
  'working_artifacts',
  'working_artifact_dependencies',
  'working_artifact_files',
  'file_objects',
  'working_artifact_revision_snapshots',
  'working_artifact_revision_files',
  'effect_import_products',
  'effect_import_workspaces',
] as const;
const source = ['effect_import_drafts', 'effect_import_materials'] as const;
const extraction = [
  'effect_extraction_runs',
  'effect_extraction_branch_outputs',
  'effect_extraction_results',
] as const;
const prompt = [
  'effect_prompt_runs',
  'effect_prompt_stage_outputs',
  'effect_prompt_shard_outputs',
  'effect_prompt_results',
] as const;
const render = [
  'effect_segment_render_batches',
  'effect_segment_render_tasks',
  'effect_segment_import_drafts',
] as const;
const mix = [
  'effect_template_mix_ai_runs',
  'effect_packaging_runs',
  'effect_packaging_items',
  'effect_packaging_files',
] as const;
const output = ['effect_final_output_runs', 'effect_final_output_items'] as const;

// Explicit dependency inventory. Include project siblings/ancestors because current template
// paths and inherited source heads may resolve to another Run. Never read JSON bodies here.
export const EFFECT_CACHE_TABLES = {
  import: [...base, ...source],
  'import-draft': [...base, ...source],
  'import-products': [...base, ...source],
  'import-removed-products': [...base, ...source],
  artifacts: [...base, ...source],
  extraction: [...base, ...source, ...extraction],
  prompt: [...base, ...prompt],
  'prompt-result': [...base, ...prompt],
  render: [...base, ...render],
  'render-workspace': [...base, ...render],
  mix: [...base, ...render, ...mix],
  'mix-sources': [...base, ...render, ...mix],
  output: [...base, ...render, ...mix, ...output],
  tree: [...base, ...source, ...mix, ...output],
} as const;
export type EffectCacheResource = keyof typeof EFFECT_CACHE_TABLES;
export type EffectCacheScope = { projectId: string; workflowRunId?: string; draftId?: string };
export type EffectCacheStamp = { workflowRunId: string; version: string; active: boolean };
const taskTables = new Set<string>([
  ...extraction.slice(0, 1),
  ...prompt.slice(0, 1),
  ...render,
  'effect_template_mix_ai_runs',
  'effect_packaging_runs',
  'effect_packaging_items',
  ...output,
]);
const revisionTables = new Set<string>([
  'working_artifacts',
  'workflow_node_states',
  'effect_import_drafts',
  'effect_extraction_results',
  'effect_prompt_results',
]);

@Injectable()
export class EffectCacheRevisionService {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

  async read(
    scope: EffectCacheScope,
    resource: EffectCacheResource,
  ): Promise<EffectCacheStamp | null> {
    // Resolve scope and all dependency versions in one PostgreSQL statement snapshot.
    const runQuery = scope.draftId
      ? Prisma.sql`SELECT r.id FROM workflow_runs r
          JOIN effect_import_workspaces w ON w."workflowRunId" = r.id AND w."projectId" = r."projectId"
          JOIN effect_import_drafts d ON d."workspaceId" = w.id AND d."projectId" = r."projectId"
          WHERE r."projectId" = ${scope.projectId}::uuid AND d.id = ${scope.draftId}::uuid
            AND r.workflow = 'EFFECT' AND r."workflowSpace" = 'EFFECT'
            ${scope.workflowRunId ? Prisma.sql`AND r.id = ${scope.workflowRunId}::uuid` : Prisma.empty}`
      : Prisma.sql`SELECT r.id FROM workflow_runs r
          WHERE r."projectId" = ${scope.projectId}::uuid
            AND r.workflow = 'EFFECT' AND r."workflowSpace" = 'EFFECT'
            ${scope.workflowRunId ? Prisma.sql`AND r.id = ${scope.workflowRunId}::uuid` : Prisma.sql`AND r."activeKey" = 'ACTIVE'`}`;
    const queries = EFFECT_CACHE_TABLES[resource].map((table) => {
      // xmin is an additional physical row version, not a business revision. It catches updates
      // to child/link rows without updatedAt, same-millisecond changes, inserts and deletions.
      // Values expire within minutes; no persisted identity or business ordering uses xmin.
      const revision = revisionTables.has(table)
        ? Prisma.sql` || ':' || t.revision::text`
        : Prisma.empty;
      const active = taskTables.has(table)
        ? Prisma.sql`COALESCE(bool_or(t.status::text IN ('QUEUED', 'RUNNING', 'PROCESSING')
          ${
            table === 'effect_segment_render_tasks'
              ? Prisma.sql` OR t."repairStatus"::text IN ('QUEUED', 'RUNNING')`
              : Prisma.empty
          }), false)`
        : Prisma.sql`false`;
      // Navigating an unchanged Run must not evict every business projection. The tree
      // exposes currentNodeId, so only that resource retains it. All other Run metadata
      // (including paths, publication, active pointer and edit-session scope) remains hashed.
      const rowVersion =
        table === 'workflow_runs'
          ? Prisma.sql`(to_jsonb(t) - 'lastActiveAt' - 'updatedAt'
            ${resource === 'tree' ? Prisma.empty : Prisma.sql` - 'currentNodeId'`})::text`
          : Prisma.sql`t.id::text || ':' || t.xmin::text ${revision}`;
      return Prisma.sql`SELECT ${table} AS name,
        md5(COALESCE(string_agg(${rowVersion}, ',' ORDER BY t.id), '')) AS version,
        ${active} AS active FROM ${Prisma.raw(table)} t WHERE t."projectId" = ${scope.projectId}::uuid`;
    });
    const rows = await this.db.$queryRaw<
      Array<{ workflowRunId: string; name: string; version: string; active: boolean }>
    >(
      Prisma.sql`WITH cache_scope AS (${runQuery})
        SELECT cache_scope.id AS "workflowRunId", versions.* FROM cache_scope
        CROSS JOIN LATERAL (${Prisma.join(queries, ' UNION ALL ')}) versions`,
    );
    const expected = new Set<string>(EFFECT_CACHE_TABLES[resource]);
    if (
      rows.length !== expected.size ||
      new Set(rows.map((row) => row.name)).size !== expected.size ||
      rows.some(
        (row) =>
          !expected.has(row.name) ||
          !row.version ||
          typeof row.active !== 'boolean' ||
          !row.workflowRunId ||
          row.workflowRunId !== rows[0]?.workflowRunId,
      )
    )
      return null;
    rows.sort((left, right) => left.name.localeCompare(right.name));
    return {
      workflowRunId: rows[0]!.workflowRunId,
      active: rows.some((row) => row.active),
      version: createHash('sha256')
        .update(JSON.stringify(rows.map(({ name, version }) => [name, version])))
        .digest('hex'),
    };
  }
}

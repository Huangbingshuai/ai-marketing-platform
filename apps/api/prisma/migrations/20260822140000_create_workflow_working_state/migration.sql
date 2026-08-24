CREATE TYPE "WorkflowRunStatus" AS ENUM ('ACTIVE', 'COMPLETED');
CREATE TYPE "WorkingArtifactKind" AS ENUM ('FILE', 'STRUCTURED');

CREATE TABLE "workflow_runs" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "workflow" "AssetWorkflow" NOT NULL,
  "workflowSpace" "AssetWorkflowSpace" NOT NULL,
  "status" "WorkflowRunStatus" NOT NULL DEFAULT 'ACTIVE',
  "activeKey" VARCHAR(32) DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "workflow_runs_projectId_id_key" ON "workflow_runs"("projectId", "id");
CREATE UNIQUE INDEX "workflow_runs_projectId_workflow_workflowSpace_activeKey_key"
  ON "workflow_runs"("projectId", "workflow", "workflowSpace", "activeKey");
CREATE INDEX "workflow_runs_projectId_workflow_workflowSpace_status_idx"
  ON "workflow_runs"("projectId", "workflow", "workflowSpace", "status");
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "effect_import_workspaces" ADD COLUMN "workflowRunId" UUID;
INSERT INTO "workflow_runs" (
  "id", "projectId", "workflow", "workflowSpace", "status", "activeKey", "createdAt", "updatedAt"
)
SELECT "id", "projectId", 'EFFECT', 'EFFECT', 'ACTIVE', 'ACTIVE', "createdAt", "updatedAt"
FROM "effect_import_workspaces";
UPDATE "effect_import_workspaces" SET "workflowRunId" = "id" WHERE "workflowRunId" IS NULL;
ALTER TABLE "effect_import_workspaces" ALTER COLUMN "workflowRunId" SET NOT NULL;
CREATE UNIQUE INDEX "effect_import_workspaces_workflowRunId_key"
  ON "effect_import_workspaces"("workflowRunId");
CREATE UNIQUE INDEX "effect_import_workspaces_projectId_workflowRunId_key"
  ON "effect_import_workspaces"("projectId", "workflowRunId");
ALTER TABLE "effect_import_workspaces" ADD CONSTRAINT "effect_import_workspaces_projectId_workflowRunId_fkey"
  FOREIGN KEY ("projectId", "workflowRunId") REFERENCES "workflow_runs"("projectId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "workflow_node_states" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "workflowRunId" UUID NOT NULL,
  "nodeId" VARCHAR(160) NOT NULL,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "contentHash" CHAR(64) NOT NULL,
  "state" JSONB NOT NULL,
  "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "workflow_node_states_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "workflow_node_states_projectId_workflowRunId_nodeId_key"
  ON "workflow_node_states"("projectId", "workflowRunId", "nodeId");
CREATE INDEX "workflow_node_states_projectId_updatedAt_idx"
  ON "workflow_node_states"("projectId", "updatedAt");
ALTER TABLE "workflow_node_states" ADD CONSTRAINT "workflow_node_states_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_node_states" ADD CONSTRAINT "workflow_node_states_projectId_workflowRunId_fkey"
  FOREIGN KEY ("projectId", "workflowRunId") REFERENCES "workflow_runs"("projectId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "working_artifacts" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "workflowRunId" UUID NOT NULL,
  "nodeId" VARCHAR(160) NOT NULL,
  "artifactKey" VARCHAR(500) NOT NULL,
  "kind" "WorkingArtifactKind" NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "directory" "AssetDirectory" NOT NULL,
  "type" "AssetType" NOT NULL,
  "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "payload" JSONB,
  "metadata" JSONB,
  "originalFileName" VARCHAR(255),
  "mimeType" VARCHAR(120),
  "sizeBytes" INTEGER,
  "storageKey" VARCHAR(500),
  "sourceRunId" VARCHAR(255),
  "sourceArtifactId" VARCHAR(255),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "working_artifacts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "working_artifacts_projectId_id_key"
  ON "working_artifacts"("projectId", "id");
CREATE UNIQUE INDEX "working_artifacts_projectId_workflowRunId_nodeId_artifactKey_key"
  ON "working_artifacts"("projectId", "workflowRunId", "nodeId", "artifactKey");
CREATE INDEX "working_artifacts_projectId_workflowRunId_nodeId_updatedAt_idx"
  ON "working_artifacts"("projectId", "workflowRunId", "nodeId", "updatedAt");
ALTER TABLE "working_artifacts" ADD CONSTRAINT "working_artifacts_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "working_artifacts" ADD CONSTRAINT "working_artifacts_projectId_workflowRunId_fkey"
  FOREIGN KEY ("projectId", "workflowRunId") REFERENCES "workflow_runs"("projectId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

WITH source_states AS (
  SELECT
    w."projectId",
    w."workflowRunId",
    d."updatedAt",
    jsonb_build_object(
      'mode', d."mode",
      'globalConfig', d."globalConfig",
      'products', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', p."id",
            'name', p."name",
            'category', p."category",
            'commerceUrl', p."commerceUrl",
            'configOverride', p."configOverride"
          ) ORDER BY p."sortOrder", p."id"
        )
        FROM "effect_import_products" p
        WHERE p."projectId" = d."projectId" AND p."draftId" = d."id"
      ), '[]'::jsonb)
    ) AS "state"
  FROM "effect_import_workspaces" w
  JOIN "effect_import_drafts" d
    ON d."projectId" = w."projectId" AND d."workspaceId" = w."id" AND d."mode" = w."currentMode"
)
INSERT INTO "workflow_node_states" (
  "id", "projectId", "workflowRunId", "nodeId", "contentHash", "state", "savedAt", "updatedAt"
)
SELECT
  gen_random_uuid(), "projectId", "workflowRunId", 'SOURCE_IMPORT',
  md5("state"::text) || md5("state"::text), "state", "updatedAt", "updatedAt"
FROM source_states;

WITH extraction_states AS (
  SELECT
    w."projectId",
    w."workflowRunId",
    MAX(r."updatedAt") AS "updatedAt",
    jsonb_build_object(
      'products', jsonb_object_agg(
        r."productId"::text,
        jsonb_build_object(
          'resultId', r."id",
          'result', r."draftResult",
          'sourceResultRevision', r."revision"
        )
      )
    ) AS "state"
  FROM "effect_import_workspaces" w
  JOIN "effect_import_drafts" d ON d."projectId" = w."projectId" AND d."workspaceId" = w."id"
  JOIN "effect_extraction_results" r ON r."projectId" = d."projectId" AND r."draftId" = d."id"
  GROUP BY w."projectId", w."workflowRunId"
)
INSERT INTO "workflow_node_states" (
  "id", "projectId", "workflowRunId", "nodeId", "contentHash", "state", "savedAt", "updatedAt"
)
SELECT
  gen_random_uuid(), "projectId", "workflowRunId", 'INFORMATION_EXTRACTION',
  md5("state"::text) || md5("state"::text), "state", "updatedAt", "updatedAt"
FROM extraction_states;

INSERT INTO "working_artifacts" (
  "id", "projectId", "workflowRunId", "nodeId", "artifactKey", "kind", "name",
  "directory", "type", "tags", "metadata", "originalFileName", "mimeType", "sizeBytes",
  "storageKey", "sourceArtifactId", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(), m."projectId", w."workflowRunId", 'SOURCE_IMPORT', 'material:' || m."id"::text,
  'FILE', COALESCE(NULLIF(p."name", ''), m."originalFileName", '工作素材'), 'SOURCE_MATERIALS',
  CASE WHEN m."type" = 'REFERENCE_VIDEO' THEN 'REFERENCE_VIDEO'::"AssetType" ELSE 'SOURCE_MATERIAL'::"AssetType" END,
  ARRAY_REMOVE(ARRAY[p."name", p."category"], ''),
  jsonb_build_object('productId', p."id", 'productName', p."name", 'materialId', m."id", 'materialType', m."type"),
  m."originalFileName", m."mimeType", m."sizeBytes", m."storageKey", m."id"::text,
  m."createdAt", m."updatedAt"
FROM "effect_import_materials" m
JOIN "effect_import_products" p ON p."projectId" = m."projectId" AND p."id" = m."productId"
JOIN "effect_import_drafts" d ON d."projectId" = p."projectId" AND d."id" = p."draftId"
JOIN "effect_import_workspaces" w ON w."projectId" = d."projectId" AND w."id" = d."workspaceId"
WHERE m."status" = 'READY' AND m."storageKey" IS NOT NULL;

INSERT INTO "working_artifacts" (
  "id", "projectId", "workflowRunId", "nodeId", "artifactKey", "kind", "name",
  "directory", "type", "tags", "payload", "metadata", "sourceRunId", "sourceArtifactId",
  "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(), r."projectId", w."workflowRunId", 'INFORMATION_EXTRACTION',
  'product:' || r."productId"::text || ':result', 'STRUCTURED',
  COALESCE(NULLIF(p."name", ''), 'AI 信息提炼结果') || ' AI 信息提炼',
  'INSIGHTS', 'INSIGHT_RESULT', ARRAY_REMOVE(ARRAY[p."name", p."category"], ''),
  r."draftResult", jsonb_build_object('productId', p."id", 'productName', p."name"),
  r."runId"::text, r."id"::text, r."createdAt", r."updatedAt"
FROM "effect_extraction_results" r
JOIN "effect_import_products" p ON p."projectId" = r."projectId" AND p."id" = r."productId"
JOIN "effect_import_drafts" d ON d."projectId" = r."projectId" AND d."id" = r."draftId"
JOIN "effect_import_workspaces" w ON w."projectId" = d."projectId" AND w."id" = d."workspaceId";

DROP TABLE IF EXISTS "effect_import_publish_file_holds";
DROP TABLE IF EXISTS "effect_import_publish_operations";
ALTER TABLE "effect_import_drafts" DROP COLUMN IF EXISTS "lastPublish";

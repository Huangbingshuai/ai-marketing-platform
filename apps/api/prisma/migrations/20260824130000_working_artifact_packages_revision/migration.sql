ALTER TYPE "WorkflowRunStatus" ADD VALUE IF NOT EXISTS 'PAUSED';
CREATE TYPE "WorkingArtifactFreshness" AS ENUM ('CURRENT', 'STALE');
CREATE TYPE "WorkingArtifactDependencySourceType" AS ENUM ('NODE_STATE', 'WORKING_ARTIFACT');
CREATE TYPE "FileObjectStatus" AS ENUM ('AVAILABLE', 'ORPHANED');
CREATE TYPE "EffectImportUploadSessionStatus" AS ENUM ('UPLOADING', 'COMPLETED', 'FAILED', 'EXPIRED');
CREATE TYPE "EffectImportUploadItemStatus" AS ENUM ('PENDING', 'UPLOADED', 'FAILED', 'REMOVED');

ALTER TABLE "workflow_runs"
  ADD COLUMN "currentNodeId" VARCHAR(160),
  ADD COLUMN "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "working_artifacts"
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "contentHash" CHAR(64) NOT NULL DEFAULT '',
  ADD COLUMN "freshness" "WorkingArtifactFreshness" NOT NULL DEFAULT 'CURRENT';

CREATE TABLE "file_objects" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "workflowRunId" UUID NOT NULL,
  "nodeId" VARCHAR(160) NOT NULL,
  "originalFileName" VARCHAR(255) NOT NULL,
  "mimeType" VARCHAR(120) NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "storageKey" VARCHAR(500) NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "status" "FileObjectStatus" NOT NULL DEFAULT 'AVAILABLE',
  "orphanedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "file_objects_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "file_objects_projectId_storageKey_key" ON "file_objects"("projectId", "storageKey");
CREATE UNIQUE INDEX "file_objects_projectId_id_key" ON "file_objects"("projectId", "id");
CREATE INDEX "file_objects_projectId_workflowRunId_status_updatedAt_idx"
  ON "file_objects"("projectId", "workflowRunId", "status", "updatedAt");
ALTER TABLE "file_objects" ADD CONSTRAINT "file_objects_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "file_objects" ADD CONSTRAINT "file_objects_projectId_workflowRunId_fkey"
  FOREIGN KEY ("projectId", "workflowRunId") REFERENCES "workflow_runs"("projectId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "working_artifact_files" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "workflowRunId" UUID NOT NULL,
  "workingArtifactId" UUID NOT NULL,
  "fileObjectId" UUID NOT NULL,
  "role" VARCHAR(80) NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "working_artifact_files_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "working_artifact_files_projectId_workingArtifactId_fileObjectId_key"
  ON "working_artifact_files"("projectId", "workingArtifactId", "fileObjectId");
CREATE INDEX "working_artifact_files_projectId_workflowRunId_workingArtifactId_sortOrder_idx"
  ON "working_artifact_files"("projectId", "workflowRunId", "workingArtifactId", "sortOrder");
CREATE INDEX "working_artifact_files_projectId_fileObjectId_idx"
  ON "working_artifact_files"("projectId", "fileObjectId");
ALTER TABLE "working_artifact_files" ADD CONSTRAINT "working_artifact_files_projectId_workingArtifactId_fkey"
  FOREIGN KEY ("projectId", "workingArtifactId") REFERENCES "working_artifacts"("projectId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "working_artifact_files" ADD CONSTRAINT "working_artifact_files_projectId_fileObjectId_fkey"
  FOREIGN KEY ("projectId", "fileObjectId") REFERENCES "file_objects"("projectId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "working_artifact_dependencies" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "workflowRunId" UUID NOT NULL,
  "dependentArtifactId" UUID NOT NULL,
  "sourceType" "WorkingArtifactDependencySourceType" NOT NULL,
  "sourceNodeId" VARCHAR(160),
  "sourceArtifactId" UUID,
  "sourceKey" VARCHAR(500) NOT NULL,
  "sourceRevision" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "working_artifact_dependencies_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "working_artifact_dependencies_projectId_dependentArtifactId_sourceType_sourceKey_key"
  ON "working_artifact_dependencies"("projectId", "dependentArtifactId", "sourceType", "sourceKey");
CREATE INDEX "working_artifact_dependencies_projectId_workflowRunId_sourceType_sourceKey_idx"
  ON "working_artifact_dependencies"("projectId", "workflowRunId", "sourceType", "sourceKey");
CREATE INDEX "working_artifact_dependencies_projectId_sourceArtifactId_idx"
  ON "working_artifact_dependencies"("projectId", "sourceArtifactId");
ALTER TABLE "working_artifact_dependencies" ADD CONSTRAINT "working_artifact_dependencies_projectId_dependentArtifactId_fkey"
  FOREIGN KEY ("projectId", "dependentArtifactId") REFERENCES "working_artifacts"("projectId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "effect_import_materials" ADD COLUMN "fileObjectId" UUID;
CREATE INDEX "effect_import_materials_projectId_fileObjectId_idx"
  ON "effect_import_materials"("projectId", "fileObjectId");
ALTER TABLE "effect_import_materials" ADD CONSTRAINT "effect_import_materials_fileObjectId_fkey"
  FOREIGN KEY ("fileObjectId") REFERENCES "file_objects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "effect_import_upload_sessions" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "workflowRunId" UUID NOT NULL,
  "draftId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "expectedRevision" INTEGER NOT NULL,
  "status" "EffectImportUploadSessionStatus" NOT NULL DEFAULT 'UPLOADING',
  "completionKey" VARCHAR(500),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "effect_import_upload_sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "effect_import_upload_sessions_projectId_id_key"
  ON "effect_import_upload_sessions"("projectId", "id");
CREATE UNIQUE INDEX "effect_import_upload_sessions_projectId_completionKey_key"
  ON "effect_import_upload_sessions"("projectId", "completionKey");
CREATE INDEX "effect_import_upload_sessions_projectId_productId_status_expiresAt_idx"
  ON "effect_import_upload_sessions"("projectId", "productId", "status", "expiresAt");
ALTER TABLE "effect_import_upload_sessions" ADD CONSTRAINT "effect_import_upload_sessions_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_import_upload_sessions" ADD CONSTRAINT "effect_import_upload_sessions_projectId_workflowRunId_fkey"
  FOREIGN KEY ("projectId", "workflowRunId") REFERENCES "workflow_runs"("projectId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_import_upload_sessions" ADD CONSTRAINT "effect_import_upload_sessions_projectId_draftId_fkey"
  FOREIGN KEY ("projectId", "draftId") REFERENCES "effect_import_drafts"("projectId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_import_upload_sessions" ADD CONSTRAINT "effect_import_upload_sessions_projectId_productId_fkey"
  FOREIGN KEY ("projectId", "productId") REFERENCES "effect_import_products"("projectId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "effect_import_upload_items" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "sessionId" UUID NOT NULL,
  "clientFileId" VARCHAR(160) NOT NULL,
  "type" "EffectImportMaterialType" NOT NULL,
  "expectedFileName" VARCHAR(255),
  "status" "EffectImportUploadItemStatus" NOT NULL DEFAULT 'PENDING',
  "originalFileName" VARCHAR(255) NOT NULL,
  "mimeType" VARCHAR(120) NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "storageKey" VARCHAR(500),
  "sha256" CHAR(64),
  "fileObjectId" UUID,
  "errorCode" VARCHAR(120),
  "errorMessage" VARCHAR(500),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "effect_import_upload_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "effect_import_upload_items_projectId_sessionId_clientFileId_key"
  ON "effect_import_upload_items"("projectId", "sessionId", "clientFileId");
CREATE INDEX "effect_import_upload_items_projectId_fileObjectId_idx"
  ON "effect_import_upload_items"("projectId", "fileObjectId");
ALTER TABLE "effect_import_upload_items" ADD CONSTRAINT "effect_import_upload_items_projectId_sessionId_fkey"
  FOREIGN KEY ("projectId", "sessionId") REFERENCES "effect_import_upload_sessions"("projectId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_import_upload_items" ADD CONSTRAINT "effect_import_upload_items_fileObjectId_fkey"
  FOREIGN KEY ("fileObjectId") REFERENCES "file_objects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "file_objects" (
  "id", "projectId", "workflowRunId", "nodeId", "originalFileName", "mimeType",
  "sizeBytes", "storageKey", "sha256", "status", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(), m."projectId", w."workflowRunId", 'SOURCE_IMPORT', m."originalFileName",
  m."mimeType", m."sizeBytes", m."storageKey", md5(m."storageKey") || md5(m."storageKey"),
  'AVAILABLE', m."createdAt", m."updatedAt"
FROM "effect_import_materials" m
JOIN "effect_import_products" p ON p."projectId" = m."projectId" AND p."id" = m."productId"
JOIN "effect_import_drafts" d ON d."projectId" = p."projectId" AND d."id" = p."draftId"
JOIN "effect_import_workspaces" w ON w."projectId" = d."projectId" AND w."id" = d."workspaceId"
WHERE m."status" = 'READY' AND m."storageKey" IS NOT NULL
  AND m."originalFileName" IS NOT NULL AND m."mimeType" IS NOT NULL AND m."sizeBytes" IS NOT NULL
ON CONFLICT ("projectId", "storageKey") DO NOTHING;

UPDATE "effect_import_materials" m
SET "fileObjectId" = f."id"
FROM "file_objects" f
WHERE f."projectId" = m."projectId" AND f."storageKey" = m."storageKey";

INSERT INTO "working_artifacts" (
  "id", "projectId", "workflowRunId", "nodeId", "artifactKey", "kind", "name",
  "directory", "type", "tags", "payload", "metadata", "revision", "contentHash",
  "freshness", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(), p."projectId", w."workflowRunId", 'SOURCE_IMPORT',
  'source-package:' || p."id"::text, 'STRUCTURED', COALESCE(NULLIF(p."name", ''), '商品资料包'),
  'SOURCE_MATERIALS', 'SOURCE_MATERIAL', ARRAY_REMOVE(ARRAY[p."name", p."category"], ''),
  jsonb_build_object(
    'productId', p."id", 'productName', p."name", 'category', p."category", 'sku', p."sku",
    'commerceUrl', p."commerceUrl", 'completeness', CASE WHEN COUNT(f."id") > 0 THEN 'WORKING' ELSE 'INCOMPLETE' END
  ),
  jsonb_build_object(
    'productId', p."id",
    'legacyArtifactIds', COALESCE(jsonb_agg(a."id") FILTER (WHERE a."id" IS NOT NULL), '[]'::jsonb)
  ),
  1, md5(p."id"::text || ':' || COUNT(f."id")::text) || md5(p."id"::text || ':' || COUNT(f."id")::text),
  'CURRENT', MIN(p."createdAt"), MAX(COALESCE(m."updatedAt", p."updatedAt"))
FROM "effect_import_products" p
JOIN "effect_import_drafts" d ON d."projectId" = p."projectId" AND d."id" = p."draftId"
JOIN "effect_import_workspaces" w ON w."projectId" = d."projectId" AND w."id" = d."workspaceId"
LEFT JOIN "effect_import_materials" m ON m."projectId" = p."projectId" AND m."productId" = p."id" AND m."status" = 'READY'
LEFT JOIN "file_objects" f ON f."projectId" = m."projectId" AND f."id" = m."fileObjectId"
LEFT JOIN "working_artifacts" a ON a."projectId" = p."projectId" AND a."workflowRunId" = w."workflowRunId"
  AND a."nodeId" = 'SOURCE_IMPORT' AND a."artifactKey" LIKE 'material:%'
  AND (a."metadata"->>'productId')::text = p."id"::text
GROUP BY p."id", p."projectId", w."workflowRunId"
ON CONFLICT ("projectId", "workflowRunId", "nodeId", "artifactKey") DO NOTHING;

INSERT INTO "working_artifact_files" (
  "id", "projectId", "workflowRunId", "workingArtifactId", "fileObjectId", "role", "sortOrder"
)
SELECT
  gen_random_uuid(), p."projectId", w."workflowRunId", a."id", f."id", m."type"::text,
  (ROW_NUMBER() OVER (PARTITION BY p."id" ORDER BY m."createdAt", m."id") - 1)::integer
FROM "effect_import_products" p
JOIN "effect_import_drafts" d ON d."projectId" = p."projectId" AND d."id" = p."draftId"
JOIN "effect_import_workspaces" w ON w."projectId" = d."projectId" AND w."id" = d."workspaceId"
JOIN "working_artifacts" a ON a."projectId" = p."projectId" AND a."workflowRunId" = w."workflowRunId"
  AND a."nodeId" = 'SOURCE_IMPORT' AND a."artifactKey" = 'source-package:' || p."id"::text
JOIN "effect_import_materials" m ON m."projectId" = p."projectId" AND m."productId" = p."id" AND m."status" = 'READY'
JOIN "file_objects" f ON f."projectId" = m."projectId" AND f."id" = m."fileObjectId"
ON CONFLICT ("projectId", "workingArtifactId", "fileObjectId") DO NOTHING;

INSERT INTO "working_artifacts" (
  "id", "projectId", "workflowRunId", "nodeId", "artifactKey", "kind", "name",
  "directory", "type", "tags", "payload", "metadata", "revision", "contentHash",
  "freshness", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(), p."projectId", w."workflowRunId", 'SOURCE_IMPORT',
  'global-video-config:' || p."id"::text, 'STRUCTURED',
  COALESCE(NULLIF(p."name", ''), '商品资料包') || ' 全局视频配置',
  'SOURCE_MATERIALS', 'VIDEO_CONFIG', ARRAY_REMOVE(ARRAY[p."name", '视频配置'], ''),
  d."globalConfig" || p."configOverride",
  jsonb_build_object('productId', p."id", 'productName', p."name"),
  1, md5((d."globalConfig" || p."configOverride")::text) || md5((d."globalConfig" || p."configOverride")::text),
  'CURRENT', p."createdAt", GREATEST(d."updatedAt", p."updatedAt")
FROM "effect_import_products" p
JOIN "effect_import_drafts" d ON d."projectId" = p."projectId" AND d."id" = p."draftId"
JOIN "effect_import_workspaces" w ON w."projectId" = d."projectId" AND w."id" = d."workspaceId"
ON CONFLICT ("projectId", "workflowRunId", "nodeId", "artifactKey") DO NOTHING;

DELETE FROM "working_artifacts" WHERE "nodeId" = 'SOURCE_IMPORT' AND "artifactKey" LIKE 'material:%';

UPDATE "working_artifacts"
SET "artifactKey" = 'marketing-insight:' || ("metadata"->>'productId'),
    "revision" = 1,
    "freshness" = 'STALE',
    "contentHash" = md5(COALESCE("payload"::text, 'null')) || md5(COALESCE("payload"::text, 'null'))
WHERE "nodeId" = 'INFORMATION_EXTRACTION' AND "metadata"->>'productId' IS NOT NULL;

UPDATE "working_artifacts"
SET "contentHash" = md5("id"::text) || md5("id"::text)
WHERE "contentHash" = '';

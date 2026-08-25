-- Expand the working-state schema first, backfill every redundant workflowRunId,
-- then add database-level same-run constraints. No user object is deleted here.
CREATE TYPE "WorkingArtifactAvailability" AS ENUM ('AVAILABLE', 'SOURCE_REMOVED', 'PENDING_DELETE');
CREATE TYPE "EffectImportProductStatus" AS ENUM ('ACTIVE', 'REMOVED');
ALTER TYPE "WorkingArtifactDependencySourceType" ADD VALUE IF NOT EXISTS 'EXECUTION_INPUT';

ALTER TABLE "workflow_node_states"
  ADD COLUMN "executionInputHash" CHAR(64) NOT NULL
    DEFAULT '0e9561cfb83d50990a103b3896fe249a11fe27fa28985448187f93ec12116d72',
  ADD COLUMN "executionInputSchemaVersion" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "working_artifacts"
  ADD COLUMN "availability" "WorkingArtifactAvailability" NOT NULL DEFAULT 'AVAILABLE';

ALTER TABLE "working_artifact_dependencies"
  ADD COLUMN "sourceHash" CHAR(64),
  ALTER COLUMN "sourceRevision" DROP NOT NULL;

ALTER TABLE "effect_import_products"
  ADD COLUMN "workflowRunId" UUID,
  ADD COLUMN "status" "EffectImportProductStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "removedAt" TIMESTAMP(3),
  ADD COLUMN "purgeAfter" TIMESTAMP(3);

ALTER TABLE "effect_import_materials" ADD COLUMN "workflowRunId" UUID;
ALTER TABLE "effect_import_upload_items" ADD COLUMN "workflowRunId" UUID;

UPDATE "effect_import_products" p
SET "workflowRunId" = w."workflowRunId"
FROM "effect_import_drafts" d
JOIN "effect_import_workspaces" w
  ON w."projectId" = d."projectId" AND w."id" = d."workspaceId"
WHERE p."projectId" = d."projectId" AND p."draftId" = d."id";

UPDATE "effect_import_materials" m
SET "workflowRunId" = p."workflowRunId"
FROM "effect_import_products" p
WHERE m."projectId" = p."projectId" AND m."productId" = p."id";

UPDATE "effect_import_upload_items" i
SET "workflowRunId" = s."workflowRunId"
FROM "effect_import_upload_sessions" s
WHERE i."projectId" = s."projectId" AND i."sessionId" = s."id";

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "effect_import_products" WHERE "workflowRunId" IS NULL) OR
     EXISTS (SELECT 1 FROM "effect_import_materials" WHERE "workflowRunId" IS NULL) OR
     EXISTS (SELECT 1 FROM "effect_import_upload_items" WHERE "workflowRunId" IS NULL) THEN
    RAISE EXCEPTION 'workflowRunId backfill failed; refusing to tighten same-run constraints';
  END IF;
END $$;

ALTER TABLE "effect_import_products" ALTER COLUMN "workflowRunId" SET NOT NULL;
ALTER TABLE "effect_import_materials" ALTER COLUMN "workflowRunId" SET NOT NULL;
ALTER TABLE "effect_import_upload_items" ALTER COLUMN "workflowRunId" SET NOT NULL;

-- A partially rolled-out environment can contain both the legacy and effective
-- key. Keep the effective-key row, reconnect every relationship, and only bump
-- its revision when the current draft + product override changes its payload.
DELETE FROM "working_artifact_dependencies" legacy_dependency
USING "working_artifacts" legacy, "working_artifacts" effective
WHERE legacy."artifactKey" LIKE 'global-video-config:%'
  AND effective."projectId" = legacy."projectId"
  AND effective."workflowRunId" = legacy."workflowRunId"
  AND effective."nodeId" = legacy."nodeId"
  AND effective."artifactKey" = replace(legacy."artifactKey", 'global-video-config:', 'effective-video-config:')
  AND legacy_dependency."sourceArtifactId" = legacy."id"
  AND EXISTS (
    SELECT 1 FROM "working_artifact_dependencies" current_dependency
    WHERE current_dependency."projectId" = legacy_dependency."projectId"
      AND current_dependency."dependentArtifactId" = legacy_dependency."dependentArtifactId"
      AND current_dependency."sourceType" = legacy_dependency."sourceType"
      AND current_dependency."sourceKey" = replace(legacy_dependency."sourceKey", 'global-video-config:', 'effective-video-config:')
  );

UPDATE "working_artifact_dependencies" dependency
SET "sourceArtifactId" = effective."id",
    "sourceKey" = replace(dependency."sourceKey", 'global-video-config:', 'effective-video-config:')
FROM "working_artifacts" legacy
JOIN "working_artifacts" effective
  ON effective."projectId" = legacy."projectId"
 AND effective."workflowRunId" = legacy."workflowRunId"
 AND effective."nodeId" = legacy."nodeId"
 AND effective."artifactKey" = replace(legacy."artifactKey", 'global-video-config:', 'effective-video-config:')
WHERE legacy."artifactKey" LIKE 'global-video-config:%'
  AND dependency."sourceArtifactId" = legacy."id";

DELETE FROM "working_artifact_dependencies" legacy_dependency
USING "working_artifacts" legacy, "working_artifacts" effective
WHERE legacy."artifactKey" LIKE 'global-video-config:%'
  AND effective."projectId" = legacy."projectId"
  AND effective."workflowRunId" = legacy."workflowRunId"
  AND effective."nodeId" = legacy."nodeId"
  AND effective."artifactKey" = replace(legacy."artifactKey", 'global-video-config:', 'effective-video-config:')
  AND legacy_dependency."dependentArtifactId" = legacy."id"
  AND EXISTS (
    SELECT 1 FROM "working_artifact_dependencies" current_dependency
    WHERE current_dependency."projectId" = legacy_dependency."projectId"
      AND current_dependency."dependentArtifactId" = effective."id"
      AND current_dependency."sourceType" = legacy_dependency."sourceType"
      AND current_dependency."sourceKey" = legacy_dependency."sourceKey"
  );

UPDATE "working_artifact_dependencies" dependency
SET "dependentArtifactId" = effective."id"
FROM "working_artifacts" legacy
JOIN "working_artifacts" effective
  ON effective."projectId" = legacy."projectId"
 AND effective."workflowRunId" = legacy."workflowRunId"
 AND effective."nodeId" = legacy."nodeId"
 AND effective."artifactKey" = replace(legacy."artifactKey", 'global-video-config:', 'effective-video-config:')
WHERE legacy."artifactKey" LIKE 'global-video-config:%'
  AND dependency."dependentArtifactId" = legacy."id";

DELETE FROM "working_artifact_files" legacy_file
USING "working_artifacts" legacy, "working_artifacts" effective
WHERE legacy."artifactKey" LIKE 'global-video-config:%'
  AND effective."projectId" = legacy."projectId"
  AND effective."workflowRunId" = legacy."workflowRunId"
  AND effective."nodeId" = legacy."nodeId"
  AND effective."artifactKey" = replace(legacy."artifactKey", 'global-video-config:', 'effective-video-config:')
  AND legacy_file."workingArtifactId" = legacy."id"
  AND EXISTS (
    SELECT 1 FROM "working_artifact_files" current_file
    WHERE current_file."projectId" = legacy_file."projectId"
      AND current_file."workingArtifactId" = effective."id"
      AND current_file."fileObjectId" = legacy_file."fileObjectId"
  );

UPDATE "working_artifact_files" artifact_file
SET "workingArtifactId" = effective."id"
FROM "working_artifacts" legacy
JOIN "working_artifacts" effective
  ON effective."projectId" = legacy."projectId"
 AND effective."workflowRunId" = legacy."workflowRunId"
 AND effective."nodeId" = legacy."nodeId"
 AND effective."artifactKey" = replace(legacy."artifactKey", 'global-video-config:', 'effective-video-config:')
WHERE legacy."artifactKey" LIKE 'global-video-config:%'
  AND artifact_file."workingArtifactId" = legacy."id";

UPDATE "working_artifacts" effective
SET "name" = left(regexp_replace(trim(product."name"), '\s+', ' ', 'g') || ' 生效视频配置', 120),
    "tags" = ARRAY[regexp_replace(trim(product."name"), '\s+', ' ', 'g'), '生效视频配置'],
    "payload" = COALESCE(draft."globalConfig", '{}'::jsonb) || COALESCE(product."configOverride", '{}'::jsonb),
    "metadata" = jsonb_build_object(
      'productId', product."id"::text,
      'productName', regexp_replace(trim(product."name"), '\s+', ' ', 'g')
    ),
    "sourceArtifactId" = product."id"::text,
    "contentHash" = repeat('0', 64),
    "revision" = effective."revision" + 1,
    "freshness" = 'CURRENT',
    "availability" = 'AVAILABLE'
FROM "working_artifacts" legacy,
     "effect_import_products" product,
     "effect_import_drafts" draft
WHERE legacy."artifactKey" LIKE 'global-video-config:%'
  AND effective."projectId" = legacy."projectId"
  AND effective."workflowRunId" = legacy."workflowRunId"
  AND effective."nodeId" = legacy."nodeId"
  AND effective."artifactKey" = replace(legacy."artifactKey", 'global-video-config:', 'effective-video-config:')
  AND product."projectId" = effective."projectId"
  AND product."id"::text = COALESCE(effective."metadata" ->> 'productId', effective."sourceArtifactId")
  AND draft."projectId" = product."projectId"
  AND draft."id" = product."draftId"
  AND (
    effective."payload" IS DISTINCT FROM
      (COALESCE(draft."globalConfig", '{}'::jsonb) || COALESCE(product."configOverride", '{}'::jsonb))
    OR effective."contentHash" IS DISTINCT FROM legacy."contentHash"
  );

WITH RECURSIVE changed_config AS (
  SELECT effective."projectId", effective."workflowRunId", effective."id"
  FROM "working_artifacts" legacy
  JOIN "working_artifacts" effective
    ON effective."projectId" = legacy."projectId"
   AND effective."workflowRunId" = legacy."workflowRunId"
   AND effective."nodeId" = legacy."nodeId"
   AND effective."artifactKey" = replace(legacy."artifactKey", 'global-video-config:', 'effective-video-config:')
  WHERE legacy."artifactKey" LIKE 'global-video-config:%'
    AND effective."contentHash" = repeat('0', 64)
), descendants AS (
  SELECT dependency."projectId", dependency."workflowRunId", dependency."dependentArtifactId" AS id
  FROM "working_artifact_dependencies" dependency
  JOIN changed_config source
    ON source."projectId" = dependency."projectId"
   AND source."workflowRunId" = dependency."workflowRunId"
   AND source."id" = dependency."sourceArtifactId"
  UNION
  SELECT dependency."projectId", dependency."workflowRunId", dependency."dependentArtifactId"
  FROM "working_artifact_dependencies" dependency
  JOIN descendants source
    ON source."projectId" = dependency."projectId"
   AND source."workflowRunId" = dependency."workflowRunId"
   AND source."id" = dependency."sourceArtifactId"
)
UPDATE "working_artifacts" artifact
SET "freshness" = 'STALE'
FROM descendants
WHERE artifact."projectId" = descendants."projectId"
  AND artifact."workflowRunId" = descendants."workflowRunId"
  AND artifact."id" = descendants."id";

DELETE FROM "working_artifacts" legacy
USING "working_artifacts" effective
WHERE legacy."artifactKey" LIKE 'global-video-config:%'
  AND effective."projectId" = legacy."projectId"
  AND effective."workflowRunId" = legacy."workflowRunId"
  AND effective."nodeId" = legacy."nodeId"
  AND effective."artifactKey" = replace(legacy."artifactKey", 'global-video-config:', 'effective-video-config:');

UPDATE "working_artifacts"
SET "artifactKey" = replace("artifactKey", 'global-video-config:', 'effective-video-config:')
WHERE "artifactKey" LIKE 'global-video-config:%';

UPDATE "working_artifact_dependencies"
SET "sourceKey" = replace("sourceKey", 'global-video-config:', 'effective-video-config:')
WHERE "sourceKey" LIKE 'global-video-config:%';

ALTER TABLE "effect_import_materials"
  DROP CONSTRAINT IF EXISTS "effect_import_materials_fileObjectId_fkey";
ALTER TABLE "effect_import_upload_items"
  DROP CONSTRAINT IF EXISTS "effect_import_upload_items_fileObjectId_fkey",
  DROP CONSTRAINT IF EXISTS "effect_import_upload_items_projectId_sessionId_fkey";
ALTER TABLE "working_artifact_dependencies"
  DROP CONSTRAINT IF EXISTS "working_artifact_dependencies_projectId_dependentArtifactId_fke";
ALTER TABLE "working_artifact_files"
  DROP CONSTRAINT IF EXISTS "working_artifact_files_projectId_fileObjectId_fkey",
  DROP CONSTRAINT IF EXISTS "working_artifact_files_projectId_workingArtifactId_fkey";

CREATE UNIQUE INDEX "working_artifacts_projectId_workflowRunId_id_key"
  ON "working_artifacts"("projectId", "workflowRunId", "id");
CREATE UNIQUE INDEX "file_objects_projectId_workflowRunId_id_key"
  ON "file_objects"("projectId", "workflowRunId", "id");
CREATE UNIQUE INDEX "effect_import_products_projectId_workflowRunId_id_key"
  ON "effect_import_products"("projectId", "workflowRunId", "id");
CREATE UNIQUE INDEX "effect_import_upload_sessions_projectId_workflowRunId_id_key"
  ON "effect_import_upload_sessions"("projectId", "workflowRunId", "id");
CREATE INDEX "effect_import_products_projectId_workflowRunId_status_purge_idx"
  ON "effect_import_products"("projectId", "workflowRunId", "status", "purgeAfter");

ALTER TABLE "working_artifact_files"
  ADD CONSTRAINT "working_artifact_files_same_run_artifact_fkey"
    FOREIGN KEY ("projectId", "workflowRunId", "workingArtifactId")
    REFERENCES "working_artifacts"("projectId", "workflowRunId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "working_artifact_files_same_run_file_fkey"
    FOREIGN KEY ("projectId", "workflowRunId", "fileObjectId")
    REFERENCES "file_objects"("projectId", "workflowRunId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "working_artifact_dependencies"
  ADD CONSTRAINT "working_artifact_dependencies_same_run_dependent_fkey"
    FOREIGN KEY ("projectId", "workflowRunId", "dependentArtifactId")
    REFERENCES "working_artifacts"("projectId", "workflowRunId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "working_artifact_dependencies_same_run_source_fkey"
    FOREIGN KEY ("projectId", "workflowRunId", "sourceArtifactId")
    REFERENCES "working_artifacts"("projectId", "workflowRunId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "effect_import_products"
  ADD CONSTRAINT "effect_import_products_same_run_fkey"
    FOREIGN KEY ("projectId", "workflowRunId") REFERENCES "workflow_runs"("projectId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "effect_import_materials"
  ADD CONSTRAINT "effect_import_materials_same_run_fkey"
    FOREIGN KEY ("projectId", "workflowRunId") REFERENCES "workflow_runs"("projectId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "effect_import_materials_same_run_file_fkey"
    FOREIGN KEY ("projectId", "workflowRunId", "fileObjectId")
    REFERENCES "file_objects"("projectId", "workflowRunId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "effect_import_upload_items"
  ADD CONSTRAINT "effect_import_upload_items_same_run_session_fkey"
    FOREIGN KEY ("projectId", "workflowRunId", "sessionId")
    REFERENCES "effect_import_upload_sessions"("projectId", "workflowRunId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "effect_import_upload_items_same_run_fkey"
    FOREIGN KEY ("projectId", "workflowRunId") REFERENCES "workflow_runs"("projectId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "effect_import_upload_items_same_run_file_fkey"
    FOREIGN KEY ("projectId", "workflowRunId", "fileObjectId")
    REFERENCES "file_objects"("projectId", "workflowRunId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

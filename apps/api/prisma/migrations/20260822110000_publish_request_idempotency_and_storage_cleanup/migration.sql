ALTER TABLE "effect_import_publish_operations"
ADD COLUMN "idempotencyKey" VARCHAR(500),
ADD COLUMN "snapshot" JSONB;

UPDATE "effect_import_publish_operations"
SET "idempotencyKey" = 'legacy:' || "id"::text,
    "snapshot" = '{}'::jsonb;

ALTER TABLE "effect_import_publish_operations"
ALTER COLUMN "idempotencyKey" SET NOT NULL,
ALTER COLUMN "snapshot" SET NOT NULL;

DROP INDEX "effect_import_publish_operations_projectId_draftId_revision_key";
CREATE UNIQUE INDEX "effect_import_publish_operations_projectId_idempotencyKey_key"
ON "effect_import_publish_operations"("projectId", "idempotencyKey");

CREATE TABLE "storage_cleanup_tasks" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "storageKey" VARCHAR(500) NOT NULL,
  "reason" VARCHAR(120) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" VARCHAR(500),
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "storage_cleanup_tasks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "storage_cleanup_tasks_projectId_storageKey_key"
ON "storage_cleanup_tasks"("projectId", "storageKey");
CREATE INDEX "storage_cleanup_tasks_projectId_nextAttemptAt_idx"
ON "storage_cleanup_tasks"("projectId", "nextAttemptAt");
ALTER TABLE "storage_cleanup_tasks"
ADD CONSTRAINT "storage_cleanup_tasks_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "effect_import_publish_file_holds" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "operationId" UUID NOT NULL,
  "storageKey" VARCHAR(500) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "effect_import_publish_file_holds_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "effect_import_publish_file_holds_projectId_operationId_storageKey_key"
ON "effect_import_publish_file_holds"("projectId", "operationId", "storageKey");
CREATE INDEX "effect_import_publish_file_holds_projectId_storageKey_idx"
ON "effect_import_publish_file_holds"("projectId", "storageKey");
ALTER TABLE "effect_import_publish_file_holds"
ADD CONSTRAINT "effect_import_publish_file_holds_projectId_operationId_fkey"
FOREIGN KEY ("projectId", "operationId") REFERENCES "effect_import_publish_operations"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

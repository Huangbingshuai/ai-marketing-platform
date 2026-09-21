CREATE TABLE "effect_packaging_runs" (
 "id" UUID PRIMARY KEY, "projectId" UUID NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
 "workflowRunId" UUID NOT NULL, "templateId" UUID NOT NULL, "idempotencyKey" VARCHAR(500) NOT NULL,
 "requestHash" CHAR(64) NOT NULL, "status" VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
 "attemptToken" UUID, "attemptCount" INTEGER NOT NULL DEFAULT 0, "leaseExpiresAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "startedAt" TIMESTAMP(3),
 "completedAt" TIMESTAMP(3), "updatedAt" TIMESTAMP(3) NOT NULL,
 UNIQUE("projectId", "id"), UNIQUE("projectId", "idempotencyKey"),
 FOREIGN KEY ("projectId", "workflowRunId") REFERENCES "workflow_runs"("projectId", "id") ON DELETE CASCADE
);
CREATE INDEX "effect_packaging_runs_scope_idx" ON "effect_packaging_runs"("projectId", "workflowRunId", "templateId", "createdAt");
CREATE INDEX "effect_packaging_runs_lease_idx" ON "effect_packaging_runs"("status", "leaseExpiresAt");
CREATE UNIQUE INDEX "effect_packaging_runs_active_idx" ON "effect_packaging_runs"("projectId", "workflowRunId", "templateId") WHERE "status" IN ('QUEUED', 'RUNNING');
CREATE TABLE "effect_packaging_items" (
 "id" UUID PRIMARY KEY, "projectId" UUID NOT NULL, "runId" UUID NOT NULL, "variantId" UUID NOT NULL,
 "name" TEXT NOT NULL, "shardIndex" INTEGER NOT NULL, "sourceTimelineHash" CHAR(64) NOT NULL,
 "snapshot" JSONB NOT NULL, "status" VARCHAR(20) NOT NULL DEFAULT 'QUEUED', "stage" VARCHAR(20) NOT NULL DEFAULT 'SNAPSHOT',
 "checkpoint" JSONB NOT NULL DEFAULT '{}', "errorMessage" TEXT, "startedAt" TIMESTAMP(3), "completedAt" TIMESTAMP(3), "updatedAt" TIMESTAMP(3) NOT NULL,
 UNIQUE("projectId", "runId", "variantId"),
 FOREIGN KEY ("projectId", "runId") REFERENCES "effect_packaging_runs"("projectId", "id") ON DELETE CASCADE
);
CREATE INDEX "effect_packaging_items_variant_idx" ON "effect_packaging_items"("projectId", "variantId");
CREATE UNIQUE INDEX "effect_packaging_items_projectId_id_key" ON "effect_packaging_items"("projectId", "id");
CREATE TABLE "effect_packaging_files" (
  "id" UUID NOT NULL, "projectId" UUID NOT NULL, "itemId" UUID NOT NULL,
  "fileObjectId" UUID NOT NULL, "role" VARCHAR(80) NOT NULL,
  CONSTRAINT "effect_packaging_files_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "effect_packaging_files_item_fkey" FOREIGN KEY ("projectId", "itemId") REFERENCES "effect_packaging_items"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "effect_packaging_files_file_fkey" FOREIGN KEY ("projectId", "fileObjectId") REFERENCES "file_objects"("projectId", "id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "effect_packaging_files_projectId_itemId_role_key" ON "effect_packaging_files"("projectId", "itemId", "role");
CREATE INDEX "effect_packaging_files_projectId_fileObjectId_idx" ON "effect_packaging_files"("projectId", "fileObjectId");

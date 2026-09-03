CREATE TYPE "EffectSegmentRenderBatchStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED');
CREATE TYPE "EffectSegmentRenderTaskStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

CREATE TABLE "effect_segment_render_batches" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "workflowRunId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "sourcePromptArtifactId" UUID NOT NULL,
  "sourcePromptRevision" INTEGER NOT NULL,
  "sourcePromptHash" CHAR(64) NOT NULL,
  "sourceFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(500) NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  "status" "EffectSegmentRenderBatchStatus" NOT NULL DEFAULT 'QUEUED',
  "activeKey" VARCHAR(32) DEFAULT 'ACTIVE',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "committedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "effect_segment_render_batches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "effect_segment_render_tasks" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "workflowRunId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "batchId" UUID NOT NULL,
  "promptId" UUID NOT NULL,
  "promptCode" VARCHAR(120) NOT NULL,
  "renderCode" VARCHAR(120) NOT NULL,
  "sourceFingerprint" CHAR(64) NOT NULL,
  "requestSnapshot" JSONB NOT NULL,
  "status" "EffectSegmentRenderTaskStatus" NOT NULL DEFAULT 'QUEUED',
  "progress" INTEGER NOT NULL DEFAULT 0,
  "renderVersion" INTEGER NOT NULL DEFAULT 1,
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "maxAutoRetries" INTEGER NOT NULL DEFAULT 2,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "attemptToken" UUID,
  "leaseExpiresAt" TIMESTAMP(3),
  "heartbeatAt" TIMESTAMP(3),
  "providerTaskId" VARCHAR(255),
  "outputFileObjectId" UUID,
  "outputStorageKey" VARCHAR(500),
  "outputFileName" VARCHAR(255),
  "outputMimeType" VARCHAR(120),
  "outputSizeBytes" INTEGER,
  "outputContentHash" CHAR(64),
  "errorCode" VARCHAR(120),
  "errorMessage" VARCHAR(1000),
  "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "effect_segment_render_tasks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "effect_segment_render_operation_receipts" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "batchId" UUID NOT NULL,
  "idempotencyKey" VARCHAR(500) NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "effect_segment_render_operation_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "effect_segment_render_batches_projectId_id_key" ON "effect_segment_render_batches"("projectId", "id");
CREATE UNIQUE INDEX "effect_segment_render_batches_projectId_idempotencyKey_key" ON "effect_segment_render_batches"("projectId", "idempotencyKey");
CREATE UNIQUE INDEX "effect_segment_render_batches_active_key" ON "effect_segment_render_batches"("projectId", "workflowRunId", "productId", "activeKey");
CREATE INDEX "effect_segment_render_batches_project_product_created_idx" ON "effect_segment_render_batches"("projectId", "workflowRunId", "productId", "createdAt");
CREATE UNIQUE INDEX "effect_segment_render_tasks_projectId_id_key" ON "effect_segment_render_tasks"("projectId", "id");
CREATE UNIQUE INDEX "effect_segment_render_tasks_project_batch_prompt_key" ON "effect_segment_render_tasks"("projectId", "batchId", "promptId");
CREATE INDEX "effect_segment_render_tasks_project_product_status_idx" ON "effect_segment_render_tasks"("projectId", "workflowRunId", "productId", "status", "updatedAt");
CREATE INDEX "effect_segment_render_tasks_status_lease_idx" ON "effect_segment_render_tasks"("status", "leaseExpiresAt");
CREATE UNIQUE INDEX "effect_segment_render_operation_receipts_project_key" ON "effect_segment_render_operation_receipts"("projectId", "idempotencyKey");
CREATE INDEX "effect_segment_render_operation_receipts_batch_created_idx" ON "effect_segment_render_operation_receipts"("projectId", "batchId", "createdAt");

ALTER TABLE "effect_segment_render_batches" ADD CONSTRAINT "effect_segment_render_batches_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_segment_render_batches" ADD CONSTRAINT "effect_segment_render_batches_workflowRun_fkey" FOREIGN KEY ("projectId", "workflowRunId") REFERENCES "workflow_runs"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_segment_render_batches" ADD CONSTRAINT "effect_segment_render_batches_product_fkey" FOREIGN KEY ("projectId", "workflowRunId", "productId") REFERENCES "effect_import_products"("projectId", "workflowRunId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_segment_render_tasks" ADD CONSTRAINT "effect_segment_render_tasks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_segment_render_tasks" ADD CONSTRAINT "effect_segment_render_tasks_workflowRun_fkey" FOREIGN KEY ("projectId", "workflowRunId") REFERENCES "workflow_runs"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_segment_render_tasks" ADD CONSTRAINT "effect_segment_render_tasks_product_fkey" FOREIGN KEY ("projectId", "workflowRunId", "productId") REFERENCES "effect_import_products"("projectId", "workflowRunId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_segment_render_tasks" ADD CONSTRAINT "effect_segment_render_tasks_batch_fkey" FOREIGN KEY ("projectId", "batchId") REFERENCES "effect_segment_render_batches"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_segment_render_operation_receipts" ADD CONSTRAINT "effect_segment_render_operation_receipts_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_segment_render_operation_receipts" ADD CONSTRAINT "effect_segment_render_operation_receipts_batch_fkey" FOREIGN KEY ("projectId", "batchId") REFERENCES "effect_segment_render_batches"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

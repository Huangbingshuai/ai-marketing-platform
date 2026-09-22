CREATE TABLE "effect_final_output_runs" (
  "id" UUID NOT NULL, "projectId" UUID NOT NULL, "workflowRunId" UUID NOT NULL,
  "templateId" UUID NOT NULL, "idempotencyKey" VARCHAR(500) NOT NULL,
  "requestHash" CHAR(64) NOT NULL, "inputHash" CHAR(64) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'QUEUED', "attemptToken" UUID,
  "leaseExpiresAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3), "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "effect_final_output_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "effect_final_output_runs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "effect_final_output_runs_projectId_workflowRunId_fkey" FOREIGN KEY ("projectId", "workflowRunId") REFERENCES "workflow_runs"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "effect_final_output_runs_projectId_id_key" ON "effect_final_output_runs"("projectId", "id");
CREATE UNIQUE INDEX "effect_final_output_runs_projectId_idempotencyKey_key" ON "effect_final_output_runs"("projectId", "idempotencyKey");
CREATE UNIQUE INDEX "effect_final_output_runs_projectId_workflowRunId_templateId_inputHash_key" ON "effect_final_output_runs"("projectId", "workflowRunId", "templateId", "inputHash");
CREATE INDEX "effect_final_output_runs_status_leaseExpiresAt_idx" ON "effect_final_output_runs"("status", "leaseExpiresAt");
CREATE TABLE "effect_final_output_items" (
  "id" UUID NOT NULL, "projectId" UUID NOT NULL, "runId" UUID NOT NULL, "variantId" UUID NOT NULL,
  "name" TEXT NOT NULL, "snapshot" JSONB NOT NULL, "status" VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
  "progress" INTEGER NOT NULL DEFAULT 0, "fileObjectId" UUID, "assetId" UUID,
  "errorMessage" TEXT, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "effect_final_output_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "effect_final_output_items_projectId_runId_fkey" FOREIGN KEY ("projectId", "runId") REFERENCES "effect_final_output_runs"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "effect_final_output_items_projectId_runId_variantId_key" ON "effect_final_output_items"("projectId", "runId", "variantId");
ALTER TABLE "effect_final_output_items" ADD CONSTRAINT "effect_final_output_items_projectId_fileObjectId_fkey" FOREIGN KEY ("projectId", "fileObjectId") REFERENCES "file_objects"("projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "effect_segment_import_drafts" (
  "id" UUID NOT NULL, "projectId" UUID NOT NULL, "workflowRunId" UUID NOT NULL,
  "batchId" UUID NOT NULL, "uploadKey" VARCHAR(500) NOT NULL,
  "fileName" VARCHAR(255) NOT NULL, "mimeType" VARCHAR(120) NOT NULL,
  "sizeBytes" INTEGER NOT NULL, "storageKey" VARCHAR(500) NOT NULL, "sha256" CHAR(64) NOT NULL,
  "durationSeconds" DOUBLE PRECISION NOT NULL, "width" INTEGER NOT NULL, "height" INTEGER NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'READY',
  "descriptionStatus" VARCHAR(20) NOT NULL DEFAULT 'IDLE', "promptText" TEXT NOT NULL DEFAULT '',
  "errorMessage" VARCHAR(500), "descriptionKey" VARCHAR(500), "attemptToken" UUID,
  "leaseExpiresAt" TIMESTAMP(3), "expiresAt" TIMESTAMP(3) NOT NULL,
  "importedTaskId" UUID, "cleanedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "effect_segment_import_drafts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "effect_segment_import_drafts_batch_fkey" FOREIGN KEY ("projectId", "batchId")
    REFERENCES "effect_segment_render_batches"("projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "effect_segment_import_drafts_projectId_id_key" ON "effect_segment_import_drafts"("projectId", "id");
CREATE UNIQUE INDEX "effect_segment_import_drafts_projectId_uploadKey_key" ON "effect_segment_import_drafts"("projectId", "uploadKey");
CREATE INDEX "effect_segment_import_drafts_status_expiresAt_idx" ON "effect_segment_import_drafts"("status", "expiresAt");

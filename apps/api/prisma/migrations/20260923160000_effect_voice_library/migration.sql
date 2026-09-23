CREATE TABLE "effect_voice_previews" (
  "id" UUID NOT NULL, "projectId" UUID NOT NULL, "workflowRunId" UUID NOT NULL,
  "templateId" UUID NOT NULL, "cacheKey" CHAR(64) NOT NULL, "snapshot" JSONB NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'QUEUED', "attemptToken" UUID,
  "leaseExpiresAt" TIMESTAMP(3), "submittedAt" TIMESTAMP(3), "fileObjectId" UUID,
  "errorCode" VARCHAR(80), "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "effect_voice_previews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "effect_voice_previews_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "effect_voice_previews_run_fkey" FOREIGN KEY ("projectId", "workflowRunId") REFERENCES "workflow_runs"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "effect_voice_previews_file_fkey" FOREIGN KEY ("projectId", "workflowRunId", "fileObjectId") REFERENCES "file_objects"("projectId", "workflowRunId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "effect_voice_previews_projectId_id_key" ON "effect_voice_previews"("projectId", "id");
CREATE INDEX "voice_preview_cache_idx" ON "effect_voice_previews"("projectId", "workflowRunId", "templateId", "cacheKey");
CREATE INDEX "effect_voice_previews_status_leaseExpiresAt_idx" ON "effect_voice_previews"("status", "leaseExpiresAt");
CREATE TABLE "effect_voice_preview_requests" (
  "projectId" UUID NOT NULL, "idempotencyKey" VARCHAR(500) NOT NULL, "requestHash" CHAR(64) NOT NULL, "previewId" UUID NOT NULL,
  CONSTRAINT "effect_voice_preview_requests_pkey" PRIMARY KEY ("projectId", "idempotencyKey"),
  CONSTRAINT "effect_voice_preview_requests_preview_fkey" FOREIGN KEY ("projectId", "previewId") REFERENCES "effect_voice_previews"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TYPE "EffectTemplateMixAiRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE "EffectTemplateMixAiRunStage" AS ENUM ('CLASSIFYING', 'MATCHING', 'SAMPLING', 'TRIMMING', 'COMPLETED');

CREATE TABLE "effect_template_mix_ai_runs" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "workflowRunId" UUID NOT NULL,
  "templateId" UUID NOT NULL,
  "targetVariantId" UUID,
  "outputVariantId" UUID,
  "idempotencyKey" VARCHAR(500) NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  "inputHash" CHAR(64) NOT NULL,
  "inputSnapshot" JSONB NOT NULL,
  "classificationResult" JSONB,
  "selectionResult" JSONB,
  "trimResult" JSONB,
  "expectedDraftRevision" INTEGER NOT NULL,
  "templateEditVersion" INTEGER NOT NULL,
  "status" "EffectTemplateMixAiRunStatus" NOT NULL DEFAULT 'QUEUED',
  "stage" "EffectTemplateMixAiRunStage" NOT NULL DEFAULT 'CLASSIFYING',
  "progress" INTEGER NOT NULL DEFAULT 0,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 2,
  "attemptToken" UUID,
  "leaseExpiresAt" TIMESTAMP(3),
  "heartbeatAt" TIMESTAMP(3),
  "errorCode" VARCHAR(120),
  "errorMessage" VARCHAR(1000),
  "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "effect_template_mix_ai_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "effect_template_mix_ai_runs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE,
  CONSTRAINT "effect_template_mix_ai_runs_projectId_workflowRunId_fkey" FOREIGN KEY ("projectId", "workflowRunId") REFERENCES "workflow_runs"("projectId", "id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "effect_template_mix_ai_runs_projectId_id_key" ON "effect_template_mix_ai_runs"("projectId", "id");
CREATE UNIQUE INDEX "effect_template_mix_ai_runs_projectId_idempotencyKey_key" ON "effect_template_mix_ai_runs"("projectId", "idempotencyKey");
CREATE INDEX "effect_template_mix_ai_runs_projectId_workflowRunId_templateId_createdAt_idx" ON "effect_template_mix_ai_runs"("projectId", "workflowRunId", "templateId", "createdAt");
CREATE INDEX "effect_template_mix_ai_runs_status_leaseExpiresAt_idx" ON "effect_template_mix_ai_runs"("status", "leaseExpiresAt");

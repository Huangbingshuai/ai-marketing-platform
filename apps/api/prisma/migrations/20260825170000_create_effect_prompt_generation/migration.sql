CREATE TYPE "EffectPromptOperation" AS ENUM ('BATCH_GENERATE', 'ITEM_REGENERATE');
CREATE TYPE "EffectPromptRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');
CREATE TYPE "EffectPromptStageStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'SKIPPED', 'FAILED');
CREATE TYPE "EffectPromptQualityStatus" AS ENUM ('PASS', 'NEEDS_REVIEW');

CREATE TABLE "effect_prompt_runs" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "workflowRunId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "operation" "EffectPromptOperation" NOT NULL,
  "targetItemId" UUID,
  "idempotencyKey" VARCHAR(500) NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  "sourceFingerprint" CHAR(64) NOT NULL,
  "settingsHash" CHAR(64) NOT NULL,
  "inputSnapshot" JSONB NOT NULL,
  "status" "EffectPromptRunStatus" NOT NULL DEFAULT 'QUEUED',
  "progress" INTEGER NOT NULL DEFAULT 0,
  "currentNode" VARCHAR(120),
  "warnings" JSONB NOT NULL DEFAULT '[]',
  "errorCode" VARCHAR(120),
  "errorMessage" VARCHAR(1000),
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "attemptToken" UUID,
  "leaseExpiresAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "heartbeatAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "effect_prompt_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "effect_prompt_stage_outputs" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "nodeId" VARCHAR(120) NOT NULL,
  "status" "EffectPromptStageStatus" NOT NULL DEFAULT 'PENDING',
  "summary" VARCHAR(500) NOT NULL DEFAULT '',
  "warnings" JSONB NOT NULL DEFAULT '[]',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "errorMessage" VARCHAR(1000),
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "effect_prompt_stage_outputs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "effect_prompt_shard_outputs" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "round" INTEGER NOT NULL,
  "shardIndex" INTEGER NOT NULL,
  "status" "EffectPromptStageStatus" NOT NULL DEFAULT 'PENDING',
  "combinationPlan" JSONB NOT NULL DEFAULT '[]',
  "items" JSONB NOT NULL DEFAULT '[]',
  "warnings" JSONB NOT NULL DEFAULT '[]',
  "errorCode" VARCHAR(120),
  "errorMessage" VARCHAR(1000),
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "effect_prompt_shard_outputs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "effect_prompt_results" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "workflowRunId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "generatedResult" JSONB NOT NULL,
  "draftResult" JSONB NOT NULL,
  "manualOverrides" JSONB NOT NULL DEFAULT '{}',
  "qualityStatus" "EffectPromptQualityStatus" NOT NULL,
  "sourceFingerprint" CHAR(64) NOT NULL,
  "settingsHash" CHAR(64) NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "savedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "effect_prompt_results_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "effect_prompt_runs_projectId_id_key" ON "effect_prompt_runs"("projectId", "id");
CREATE UNIQUE INDEX "effect_prompt_runs_projectId_idempotencyKey_key" ON "effect_prompt_runs"("projectId", "idempotencyKey");
CREATE INDEX "effect_prompt_runs_projectId_workflowRunId_productId_status_updatedAt_idx" ON "effect_prompt_runs"("projectId", "workflowRunId", "productId", "status", "updatedAt");
CREATE INDEX "effect_prompt_runs_status_leaseExpiresAt_idx" ON "effect_prompt_runs"("status", "leaseExpiresAt");
CREATE UNIQUE INDEX "effect_prompt_runs_one_active_product" ON "effect_prompt_runs"("projectId", "workflowRunId", "productId") WHERE "status" IN ('QUEUED', 'RUNNING');
CREATE UNIQUE INDEX "effect_prompt_stage_outputs_projectId_runId_nodeId_key" ON "effect_prompt_stage_outputs"("projectId", "runId", "nodeId");
CREATE INDEX "effect_prompt_stage_outputs_projectId_runId_updatedAt_idx" ON "effect_prompt_stage_outputs"("projectId", "runId", "updatedAt");
CREATE UNIQUE INDEX "effect_prompt_shard_outputs_projectId_runId_round_shardIndex_key" ON "effect_prompt_shard_outputs"("projectId", "runId", "round", "shardIndex");
CREATE INDEX "effect_prompt_shard_outputs_projectId_runId_round_shardIndex_idx" ON "effect_prompt_shard_outputs"("projectId", "runId", "round", "shardIndex");
CREATE UNIQUE INDEX "effect_prompt_results_runId_key" ON "effect_prompt_results"("runId");
CREATE UNIQUE INDEX "effect_prompt_results_projectId_id_key" ON "effect_prompt_results"("projectId", "id");
CREATE UNIQUE INDEX "effect_prompt_results_projectId_runId_key" ON "effect_prompt_results"("projectId", "runId");
CREATE INDEX "effect_prompt_results_projectId_workflowRunId_productId_createdAt_idx" ON "effect_prompt_results"("projectId", "workflowRunId", "productId", "createdAt");

ALTER TABLE "effect_prompt_runs" ADD CONSTRAINT "effect_prompt_runs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_prompt_runs" ADD CONSTRAINT "effect_prompt_runs_projectId_workflowRunId_fkey" FOREIGN KEY ("projectId", "workflowRunId") REFERENCES "workflow_runs"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_prompt_runs" ADD CONSTRAINT "effect_prompt_runs_projectId_workflowRunId_productId_fkey" FOREIGN KEY ("projectId", "workflowRunId", "productId") REFERENCES "effect_import_products"("projectId", "workflowRunId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_prompt_stage_outputs" ADD CONSTRAINT "effect_prompt_stage_outputs_projectId_runId_fkey" FOREIGN KEY ("projectId", "runId") REFERENCES "effect_prompt_runs"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_prompt_shard_outputs" ADD CONSTRAINT "effect_prompt_shard_outputs_projectId_runId_fkey" FOREIGN KEY ("projectId", "runId") REFERENCES "effect_prompt_runs"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_prompt_results" ADD CONSTRAINT "effect_prompt_results_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_prompt_results" ADD CONSTRAINT "effect_prompt_results_projectId_workflowRunId_fkey" FOREIGN KEY ("projectId", "workflowRunId") REFERENCES "workflow_runs"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_prompt_results" ADD CONSTRAINT "effect_prompt_results_projectId_workflowRunId_productId_fkey" FOREIGN KEY ("projectId", "workflowRunId", "productId") REFERENCES "effect_import_products"("projectId", "workflowRunId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_prompt_results" ADD CONSTRAINT "effect_prompt_results_projectId_runId_fkey" FOREIGN KEY ("projectId", "runId") REFERENCES "effect_prompt_runs"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

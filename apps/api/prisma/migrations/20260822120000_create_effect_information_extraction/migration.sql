CREATE TYPE "EffectExtractionRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');
CREATE TYPE "EffectExtractionBranch" AS ENUM ('DOCUMENT', 'IMAGE', 'COMMERCE', 'FORM', 'FUSION', 'NORMALIZATION');
CREATE TYPE "EffectExtractionBranchStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'SKIPPED', 'FAILED');
CREATE TYPE "JobOutboxStatus" AS ENUM ('PENDING', 'PUBLISHED');

CREATE TABLE "effect_extraction_runs" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "draftId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "requestRevision" INTEGER NOT NULL,
  "idempotencyKey" VARCHAR(500) NOT NULL,
  "requestHash" VARCHAR(64) NOT NULL,
  "sourceFingerprint" VARCHAR(64) NOT NULL,
  "inputSnapshot" JSONB NOT NULL,
  "status" "EffectExtractionRunStatus" NOT NULL DEFAULT 'QUEUED',
  "progress" INTEGER NOT NULL DEFAULT 0,
  "currentNode" VARCHAR(120),
  "warnings" JSONB NOT NULL,
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
  CONSTRAINT "effect_extraction_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "effect_extraction_branch_outputs" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "branch" "EffectExtractionBranch" NOT NULL,
  "status" "EffectExtractionBranchStatus" NOT NULL DEFAULT 'PENDING',
  "structuredOutput" JSONB,
  "textStorageKey" VARCHAR(500),
  "warnings" JSONB NOT NULL,
  "errorCode" VARCHAR(120),
  "errorMessage" VARCHAR(1000),
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "effect_extraction_branch_outputs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "effect_extraction_results" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "draftId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "generatedResult" JSONB NOT NULL,
  "draftResult" JSONB NOT NULL,
  "provenance" JSONB NOT NULL,
  "conflictReport" JSONB NOT NULL,
  "sourceFingerprint" VARCHAR(64) NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "savedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "effect_extraction_results_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "job_outbox" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "jobType" VARCHAR(120) NOT NULL,
  "aggregateId" UUID NOT NULL,
  "routingKey" VARCHAR(160) NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "JobOutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "dispatchToken" UUID,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" VARCHAR(1000),
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "job_outbox_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "effect_extraction_file_holds" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "storageKey" VARCHAR(500) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "effect_extraction_file_holds_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "effect_extraction_artifacts" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "artifactKind" VARCHAR(120) NOT NULL,
  "sourceId" VARCHAR(255),
  "idempotencyKey" VARCHAR(500) NOT NULL,
  "originalFileName" VARCHAR(255) NOT NULL,
  "mimeType" VARCHAR(120) NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "storageKey" VARCHAR(500) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "effect_extraction_artifacts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "effect_extraction_runs_projectId_id_key" ON "effect_extraction_runs"("projectId", "id");
CREATE UNIQUE INDEX "effect_extraction_runs_projectId_idempotencyKey_key" ON "effect_extraction_runs"("projectId", "idempotencyKey");
CREATE INDEX "effect_extraction_runs_projectId_draftId_productId_status_updatedAt_idx" ON "effect_extraction_runs"("projectId", "draftId", "productId", "status", "updatedAt");
CREATE INDEX "effect_extraction_runs_status_leaseExpiresAt_idx" ON "effect_extraction_runs"("status", "leaseExpiresAt");
CREATE UNIQUE INDEX "effect_extraction_branch_outputs_projectId_runId_branch_key" ON "effect_extraction_branch_outputs"("projectId", "runId", "branch");
CREATE INDEX "effect_extraction_branch_outputs_projectId_runId_updatedAt_idx" ON "effect_extraction_branch_outputs"("projectId", "runId", "updatedAt");
CREATE UNIQUE INDEX "effect_extraction_results_runId_key" ON "effect_extraction_results"("runId");
CREATE UNIQUE INDEX "effect_extraction_results_projectId_id_key" ON "effect_extraction_results"("projectId", "id");
CREATE UNIQUE INDEX "effect_extraction_results_projectId_runId_key" ON "effect_extraction_results"("projectId", "runId");
CREATE INDEX "effect_extraction_results_projectId_draftId_productId_createdAt_idx" ON "effect_extraction_results"("projectId", "draftId", "productId", "createdAt");
CREATE UNIQUE INDEX "job_outbox_projectId_jobType_aggregateId_key" ON "job_outbox"("projectId", "jobType", "aggregateId");
CREATE INDEX "job_outbox_status_nextAttemptAt_idx" ON "job_outbox"("status", "nextAttemptAt");
CREATE UNIQUE INDEX "effect_extraction_file_holds_projectId_runId_storageKey_key" ON "effect_extraction_file_holds"("projectId", "runId", "storageKey");
CREATE INDEX "effect_extraction_file_holds_projectId_storageKey_idx" ON "effect_extraction_file_holds"("projectId", "storageKey");
CREATE UNIQUE INDEX "effect_extraction_artifacts_projectId_runId_idempotencyKey_key" ON "effect_extraction_artifacts"("projectId", "runId", "idempotencyKey");
CREATE INDEX "effect_extraction_artifacts_projectId_runId_artifactKind_idx" ON "effect_extraction_artifacts"("projectId", "runId", "artifactKind");

ALTER TABLE "effect_extraction_runs" ADD CONSTRAINT "effect_extraction_runs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_extraction_runs" ADD CONSTRAINT "effect_extraction_runs_projectId_draftId_fkey" FOREIGN KEY ("projectId", "draftId") REFERENCES "effect_import_drafts"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_extraction_runs" ADD CONSTRAINT "effect_extraction_runs_projectId_productId_fkey" FOREIGN KEY ("projectId", "productId") REFERENCES "effect_import_products"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_extraction_branch_outputs" ADD CONSTRAINT "effect_extraction_branch_outputs_projectId_runId_fkey" FOREIGN KEY ("projectId", "runId") REFERENCES "effect_extraction_runs"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_extraction_results" ADD CONSTRAINT "effect_extraction_results_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_extraction_results" ADD CONSTRAINT "effect_extraction_results_projectId_draftId_fkey" FOREIGN KEY ("projectId", "draftId") REFERENCES "effect_import_drafts"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_extraction_results" ADD CONSTRAINT "effect_extraction_results_projectId_productId_fkey" FOREIGN KEY ("projectId", "productId") REFERENCES "effect_import_products"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_extraction_results" ADD CONSTRAINT "effect_extraction_results_projectId_runId_fkey" FOREIGN KEY ("projectId", "runId") REFERENCES "effect_extraction_runs"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "job_outbox" ADD CONSTRAINT "job_outbox_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_extraction_file_holds" ADD CONSTRAINT "effect_extraction_file_holds_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_extraction_file_holds" ADD CONSTRAINT "effect_extraction_file_holds_projectId_runId_fkey" FOREIGN KEY ("projectId", "runId") REFERENCES "effect_extraction_runs"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_extraction_artifacts" ADD CONSTRAINT "effect_extraction_artifacts_projectId_runId_fkey" FOREIGN KEY ("projectId", "runId") REFERENCES "effect_extraction_runs"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

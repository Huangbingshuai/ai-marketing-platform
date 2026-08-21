CREATE TYPE "EffectImportPublishOperationStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

ALTER TABLE "effect_manifest_imports"
ADD COLUMN "commitIdempotencyKey" VARCHAR(500);

CREATE TABLE "asset_operation_receipts" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "operationKey" VARCHAR(500) NOT NULL,
  "assetId" UUID NOT NULL,
  "assetVersionId" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "asset_operation_receipts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "effect_import_publish_operations" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "draftId" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "status" "EffectImportPublishOperationStatus" NOT NULL DEFAULT 'RUNNING',
  "attemptToken" UUID NOT NULL,
  "result" JSONB,
  "errorMessage" VARCHAR(500),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "effect_import_publish_operations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "asset_operation_receipts_projectId_operationKey_key" ON "asset_operation_receipts"("projectId", "operationKey");
CREATE INDEX "asset_operation_receipts_projectId_assetId_idx" ON "asset_operation_receipts"("projectId", "assetId");
CREATE UNIQUE INDEX "effect_import_publish_operations_projectId_draftId_revision_key" ON "effect_import_publish_operations"("projectId", "draftId", "revision");
CREATE UNIQUE INDEX "effect_import_publish_operations_projectId_id_key" ON "effect_import_publish_operations"("projectId", "id");
CREATE INDEX "effect_import_publish_operations_projectId_draftId_status_updatedAt_idx" ON "effect_import_publish_operations"("projectId", "draftId", "status", "updatedAt");

ALTER TABLE "asset_operation_receipts" ADD CONSTRAINT "asset_operation_receipts_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "effect_import_publish_operations" ADD CONSTRAINT "effect_import_publish_operations_projectId_draftId_fkey" FOREIGN KEY ("projectId", "draftId") REFERENCES "effect_import_drafts"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

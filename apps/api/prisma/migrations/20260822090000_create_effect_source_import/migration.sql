CREATE TYPE "EffectImportMode" AS ENUM ('SINGLE', 'BATCH');
CREATE TYPE "EffectImportDraftStatus" AS ENUM ('DRAFT', 'VALID', 'COMPLETED');
CREATE TYPE "EffectImportMaterialType" AS ENUM ('PRODUCT_IMAGE', 'PRODUCT_DOCUMENT', 'BRAND_GUIDELINE', 'REFERENCE_VIDEO');
CREATE TYPE "EffectImportMaterialStatus" AS ENUM ('MISSING', 'UPLOADING', 'READY', 'FAILED');
CREATE TYPE "EffectImportFailureDisposition" AS ENUM ('RETRYABLE', 'REQUIRES_NEW_FILE');
CREATE TYPE "EffectManifestImportStatus" AS ENUM ('PREVIEW', 'COMMITTED', 'CANCELLED', 'EXPIRED');
CREATE TYPE "EffectManifestFormat" AS ENUM ('csv', 'xlsx');
CREATE TYPE "EffectManifestFileMatchStatus" AS ENUM ('MATCHED', 'MISSING', 'AMBIGUOUS');

CREATE TABLE "effect_import_workspaces" ("id" UUID NOT NULL, "projectId" UUID NOT NULL, "currentMode" "EffectImportMode" NOT NULL DEFAULT 'SINGLE', "revision" INTEGER NOT NULL DEFAULT 1, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "effect_import_workspaces_pkey" PRIMARY KEY ("id"));
CREATE TABLE "effect_import_drafts" ("id" UUID NOT NULL, "projectId" UUID NOT NULL, "workspaceId" UUID NOT NULL, "mode" "EffectImportMode" NOT NULL, "status" "EffectImportDraftStatus" NOT NULL DEFAULT 'DRAFT', "globalConfig" JSONB NOT NULL, "revision" INTEGER NOT NULL DEFAULT 1, "validatedRevision" INTEGER, "validationIssues" JSONB NOT NULL, "validatedAt" TIMESTAMP(3), "completedAt" TIMESTAMP(3), "lastPublish" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "effect_import_drafts_pkey" PRIMARY KEY ("id"));
CREATE TABLE "effect_import_products" ("id" UUID NOT NULL, "projectId" UUID NOT NULL, "draftId" UUID NOT NULL, "name" VARCHAR(120) NOT NULL DEFAULT '', "category" VARCHAR(120) NOT NULL DEFAULT '', "sku" VARCHAR(160) NOT NULL DEFAULT '', "normalizedSku" VARCHAR(160) NOT NULL DEFAULT '', "commerceUrl" VARCHAR(2000), "configOverride" JSONB NOT NULL, "sortOrder" INTEGER NOT NULL DEFAULT 0, "sourceManifestImportId" UUID, "sourceManifestRowNumber" INTEGER, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "effect_import_products_pkey" PRIMARY KEY ("id"));
CREATE TABLE "effect_import_materials" ("id" UUID NOT NULL, "projectId" UUID NOT NULL, "productId" UUID NOT NULL, "type" "EffectImportMaterialType" NOT NULL, "status" "EffectImportMaterialStatus" NOT NULL DEFAULT 'UPLOADING', "expectedFileName" VARCHAR(255), "originalFileName" VARCHAR(255), "mimeType" VARCHAR(120), "sizeBytes" INTEGER, "storageKey" VARCHAR(500), "failureDisposition" "EffectImportFailureDisposition", "errorCode" VARCHAR(120), "errorMessage" VARCHAR(500), "retryCount" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "effect_import_materials_pkey" PRIMARY KEY ("id"));
CREATE TABLE "effect_manifest_imports" ("id" UUID NOT NULL, "projectId" UUID NOT NULL, "draftId" UUID NOT NULL, "status" "EffectManifestImportStatus" NOT NULL DEFAULT 'PREVIEW', "format" "EffectManifestFormat" NOT NULL, "originalFileName" VARCHAR(255) NOT NULL, "rowCount" INTEGER NOT NULL, "previewRows" JSONB NOT NULL, "issues" JSONB NOT NULL, "idempotencyKey" VARCHAR(500), "expiresAt" TIMESTAMP(3) NOT NULL, "committedAt" TIMESTAMP(3), "cancelledAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "effect_manifest_imports_pkey" PRIMARY KEY ("id"));
CREATE TABLE "effect_manifest_staged_files" ("id" UUID NOT NULL, "projectId" UUID NOT NULL, "manifestImportId" UUID NOT NULL, "originalFileName" VARCHAR(255) NOT NULL, "mimeType" VARCHAR(120) NOT NULL, "sizeBytes" INTEGER NOT NULL, "storageKey" VARCHAR(500) NOT NULL, "matchedRowNumbers" INTEGER[] DEFAULT ARRAY[]::INTEGER[], "matchedMaterialType" "EffectImportMaterialType", "matchStatus" "EffectManifestFileMatchStatus" NOT NULL, "transferredAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "effect_manifest_staged_files_pkey" PRIMARY KEY ("id"));

CREATE UNIQUE INDEX "effect_import_workspaces_projectId_key" ON "effect_import_workspaces"("projectId");
CREATE UNIQUE INDEX "effect_import_workspaces_projectId_id_key" ON "effect_import_workspaces"("projectId", "id");
CREATE UNIQUE INDEX "effect_import_drafts_projectId_mode_key" ON "effect_import_drafts"("projectId", "mode");
CREATE UNIQUE INDEX "effect_import_drafts_projectId_id_key" ON "effect_import_drafts"("projectId", "id");
CREATE INDEX "effect_import_drafts_projectId_updatedAt_idx" ON "effect_import_drafts"("projectId", "updatedAt");
CREATE UNIQUE INDEX "effect_import_products_projectId_id_key" ON "effect_import_products"("projectId", "id");
CREATE INDEX "effect_import_products_projectId_draftId_sortOrder_idx" ON "effect_import_products"("projectId", "draftId", "sortOrder");
CREATE INDEX "effect_import_products_projectId_draftId_normalizedSku_idx" ON "effect_import_products"("projectId", "draftId", "normalizedSku");
CREATE UNIQUE INDEX "effect_import_materials_projectId_id_key" ON "effect_import_materials"("projectId", "id");
CREATE INDEX "effect_import_materials_projectId_productId_type_idx" ON "effect_import_materials"("projectId", "productId", "type");
CREATE UNIQUE INDEX "effect_manifest_imports_projectId_id_key" ON "effect_manifest_imports"("projectId", "id");
CREATE UNIQUE INDEX "effect_manifest_imports_projectId_draftId_idempotencyKey_key" ON "effect_manifest_imports"("projectId", "draftId", "idempotencyKey");
CREATE INDEX "effect_manifest_imports_projectId_draftId_status_expiresAt_idx" ON "effect_manifest_imports"("projectId", "draftId", "status", "expiresAt");
CREATE UNIQUE INDEX "effect_manifest_staged_files_projectId_id_key" ON "effect_manifest_staged_files"("projectId", "id");
CREATE INDEX "effect_manifest_staged_files_projectId_manifestImportId_idx" ON "effect_manifest_staged_files"("projectId", "manifestImportId");

ALTER TABLE "effect_import_workspaces" ADD CONSTRAINT "effect_import_workspaces_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_import_drafts" ADD CONSTRAINT "effect_import_drafts_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "effect_import_workspaces"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_import_products" ADD CONSTRAINT "effect_import_products_projectId_draftId_fkey" FOREIGN KEY ("projectId", "draftId") REFERENCES "effect_import_drafts"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_import_products" ADD CONSTRAINT "effect_import_products_projectId_sourceManifestImportId_fkey" FOREIGN KEY ("projectId", "sourceManifestImportId") REFERENCES "effect_manifest_imports"("projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "effect_import_materials" ADD CONSTRAINT "effect_import_materials_projectId_productId_fkey" FOREIGN KEY ("projectId", "productId") REFERENCES "effect_import_products"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_manifest_imports" ADD CONSTRAINT "effect_manifest_imports_projectId_draftId_fkey" FOREIGN KEY ("projectId", "draftId") REFERENCES "effect_import_drafts"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "effect_manifest_staged_files" ADD CONSTRAINT "effect_manifest_staged_files_projectId_manifestImportId_fkey" FOREIGN KEY ("projectId", "manifestImportId") REFERENCES "effect_manifest_imports"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

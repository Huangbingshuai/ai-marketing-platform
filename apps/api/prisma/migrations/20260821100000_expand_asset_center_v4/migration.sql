CREATE TYPE "AssetWorkflow" AS ENUM ('EFFECT', 'CUSTOMIZED', 'FISSION');
CREATE TYPE "AssetWorkflowSpace" AS ENUM ('EFFECT', 'CUSTOMIZED_PROJECT', 'CUSTOMIZED_VOICE_LIBRARY', 'FISSION_CLONE', 'FISSION_AVATAR', 'FISSION_LOCAL_REPLACE');
CREATE TYPE "AssetStatus" AS ENUM ('AVAILABLE', 'PENDING_REVIEW', 'QUALITY_WARNING', 'UNAVAILABLE');

ALTER TYPE "AssetDirectory" ADD VALUE 'SOURCE_VIDEOS';
ALTER TYPE "AssetDirectory" ADD VALUE 'SUBTITLES';
ALTER TYPE "AssetDirectory" ADD VALUE 'INSIGHTS';
ALTER TYPE "AssetDirectory" ADD VALUE 'REPLACEMENT_PLANS';
ALTER TYPE "AssetDirectory" ADD VALUE 'REPLACEMENT_CONFIGS';
ALTER TYPE "AssetDirectory" ADD VALUE 'REPLACEMENT_REFERENCES';
ALTER TYPE "AssetDirectory" ADD VALUE 'ARCHIVES';

ALTER TYPE "AssetType" ADD VALUE 'AVATAR_REFERENCE';
ALTER TYPE "AssetType" ADD VALUE 'PERSON_ASSET';
ALTER TYPE "AssetType" ADD VALUE 'GENERIC_VIDEO';
ALTER TYPE "AssetType" ADD VALUE 'REFERENCE_VIDEO';
ALTER TYPE "AssetType" ADD VALUE 'SOURCE_VIDEO';
ALTER TYPE "AssetType" ADD VALUE 'SUBTITLE';
ALTER TYPE "AssetType" ADD VALUE 'VIDEO_CONFIG';
ALTER TYPE "AssetType" ADD VALUE 'INSIGHT_RESULT';
ALTER TYPE "AssetType" ADD VALUE 'ARCHIVE_DELIVERABLE';
ALTER TYPE "AssetType" ADD VALUE 'REPLACEMENT_MAPPING';
ALTER TYPE "AssetType" ADD VALUE 'REPLACEMENT_CONFIGURATION';
ALTER TYPE "AssetType" ADD VALUE 'REFERENCE_SET';

ALTER TABLE "projects"
  ADD COLUMN "client" VARCHAR(120),
  ADD COLUMN "productName" VARCHAR(120),
  ADD COLUMN "iconKey" VARCHAR(80),
  ADD COLUMN "defaultWorkflow" "AssetWorkflow",
  ADD COLUMN "defaultSpace" "AssetWorkflowSpace";

ALTER TABLE "assets"
  ADD COLUMN "hasFile" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "storageWorkflow" "AssetWorkflow" NOT NULL DEFAULT 'EFFECT',
  ADD COLUMN "workflowSpace" "AssetWorkflowSpace" NOT NULL DEFAULT 'EFFECT',
  ADD COLUMN "status" "AssetStatus" NOT NULL DEFAULT 'AVAILABLE',
  ADD COLUMN "qualityStatus" "AssetStatus" NOT NULL DEFAULT 'AVAILABLE',
  ADD COLUMN "currentVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "assetClass" VARCHAR(120),
  ADD COLUMN "businessType" VARCHAR(160),
  ADD COLUMN "contentKind" VARCHAR(160),
  ADD COLUMN "content" JSONB,
  ADD COLUMN "businessData" JSONB,
  ADD COLUMN "views" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "sourceArtifactId" VARCHAR(255),
  ADD COLUMN "sourceRunId" VARCHAR(255),
  ADD COLUMN "sourceNode" VARCHAR(255),
  ADD COLUMN "sourceShot" VARCHAR(255),
  ADD COLUMN "idempotencyKey" VARCHAR(500),
  ADD COLUMN "sourceProjectId" UUID,
  ADD COLUMN "sourceAssetId" UUID,
  ADD COLUMN "sourceVersion" INTEGER,
  ADD COLUMN "importedAt" TIMESTAMP(3),
  ADD COLUMN "dependencies" JSONB;

CREATE INDEX "assets_projectId_storageWorkflow_workflowSpace_archivedAt_idx"
  ON "assets"("projectId", "storageWorkflow", "workflowSpace", "archivedAt");
CREATE UNIQUE INDEX "assets_projectId_storageWorkflow_workflowSpace_idempotencyKey_key"
  ON "assets"("projectId", "storageWorkflow", "workflowSpace", "idempotencyKey");

CREATE TABLE "asset_versions" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "assetId" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "changeNote" VARCHAR(2000) NOT NULL,
  "status" "AssetStatus" NOT NULL,
  "qualityStatus" "AssetStatus" NOT NULL,
  "content" JSONB,
  "businessData" JSONB,
  "originalFileName" VARCHAR(255) NOT NULL,
  "mimeType" VARCHAR(120) NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "storageKey" VARCHAR(500) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "asset_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "asset_versions_projectId_assetId_version_key" ON "asset_versions"("projectId", "assetId", "version");
CREATE INDEX "asset_versions_projectId_assetId_createdAt_idx" ON "asset_versions"("projectId", "assetId", "createdAt");
ALTER TABLE "asset_versions" ADD CONSTRAINT "asset_versions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "asset_versions" ADD CONSTRAINT "asset_versions_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "asset_versions" (
  "id", "projectId", "assetId", "version", "changeNote", "status", "qualityStatus",
  "originalFileName", "mimeType", "sizeBytes", "storageKey", "createdAt"
)
SELECT gen_random_uuid(), "projectId", "id", 1, '初始导入版本', 'AVAILABLE', 'AVAILABLE',
       "originalFileName", "mimeType", "sizeBytes", "storageKey", "createdAt"
FROM "assets";

CREATE TYPE "AssetDirectory" AS ENUM (
  'SOURCE_MATERIALS', 'SCRIPTS', 'PROMPTS', 'VISUAL_ASSETS', 'AUDIO_ASSETS',
  'VIDEO_MATERIALS', 'EDITING_PROJECTS', 'FINAL_VIDEOS', 'REPORTS_DELIVERABLES'
);

CREATE TYPE "AssetType" AS ENUM (
  'SOURCE_MATERIAL', 'SCRIPT_COPY', 'STORYBOARD_SCRIPT', 'PROMPT',
  'DIGITAL_HUMAN_CHARACTER', 'PRODUCT_ASSET', 'SCENE_BACKGROUND', 'VISUAL_ASSET',
  'VOICE_PROFILE', 'VOICE_AUDIO', 'VIDEO_MATERIAL', 'MIX_TEMPLATE',
  'TIMELINE_PROJECT', 'EDITING_PROJECT', 'FINAL_VIDEO',
  'ANALYSIS_QUALITY_REPORT', 'DELIVERY_MANIFEST'
);

CREATE TABLE "assets" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "directory" "AssetDirectory" NOT NULL,
  "type" "AssetType" NOT NULL,
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "notes" VARCHAR(2000),
  "originalFileName" VARCHAR(255) NOT NULL,
  "mimeType" VARCHAR(120) NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "storageKey" VARCHAR(500) NOT NULL,
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "assets_projectId_archivedAt_updatedAt_idx"
  ON "assets"("projectId", "archivedAt", "updatedAt");
CREATE INDEX "assets_projectId_directory_type_archivedAt_idx"
  ON "assets"("projectId", "directory", "type", "archivedAt");

ALTER TABLE "assets"
  ADD CONSTRAINT "assets_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "projects"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

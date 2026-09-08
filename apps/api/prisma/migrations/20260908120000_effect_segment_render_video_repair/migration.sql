CREATE TYPE "EffectSegmentRenderOperationKind" AS ENUM ('GENERATE', 'REPAIR');
CREATE TYPE "EffectSegmentRenderRepairStatus" AS ENUM ('QUEUED', 'RUNNING', 'READY', 'FAILED');

ALTER TABLE "effect_segment_render_tasks"
  ADD COLUMN "generationRequestSnapshot" JSONB,
  ADD COLUMN "operationKind" "EffectSegmentRenderOperationKind" NOT NULL DEFAULT 'GENERATE',
  ADD COLUMN "activeOutputVersion" INTEGER,
  ADD COLUMN "repairStatus" "EffectSegmentRenderRepairStatus",
  ADD COLUMN "repairSourceVersion" INTEGER,
  ADD COLUMN "repairStartMs" INTEGER,
  ADD COLUMN "repairEndMs" INTEGER,
  ADD COLUMN "repairRegion" JSONB,
  ADD COLUMN "repairInstruction" VARCHAR(1000),
  ADD COLUMN "repairRequestHash" CHAR(64),
  ADD COLUMN "repairCandidateFileObjectId" UUID,
  ADD COLUMN "repairCandidateStorageKey" VARCHAR(500),
  ADD COLUMN "repairCandidateFileName" VARCHAR(255),
  ADD COLUMN "repairCandidateMimeType" VARCHAR(120),
  ADD COLUMN "repairCandidateSizeBytes" INTEGER,
  ADD COLUMN "repairCandidateContentHash" CHAR(64),
  ADD COLUMN "repairCandidateVersion" INTEGER,
  ADD COLUMN "repairCandidateCreatedAt" TIMESTAMP(3);

UPDATE "effect_segment_render_tasks"
SET
  "generationRequestSnapshot" = "requestSnapshot",
  "activeOutputVersion" = CASE
    WHEN "outputFileObjectId" IS NOT NULL THEN "renderVersion"
    ELSE NULL
  END;

ALTER TABLE "effect_segment_render_tasks"
  ALTER COLUMN "generationRequestSnapshot" SET NOT NULL;

ALTER TABLE "effect_segment_import_drafts"
  ADD COLUMN "primaryPurpose" VARCHAR(30),
  ADD COLUMN "compatiblePurposes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

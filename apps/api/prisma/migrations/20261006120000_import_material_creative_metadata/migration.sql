ALTER TABLE "effect_segment_import_drafts"
  ADD COLUMN "creativeCore" VARCHAR(160) NOT NULL DEFAULT '',
  ADD COLUMN "dimensions" JSONB NOT NULL DEFAULT '{}';

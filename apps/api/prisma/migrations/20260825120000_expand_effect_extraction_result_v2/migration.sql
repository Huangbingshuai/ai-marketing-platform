ALTER TABLE "effect_extraction_results"
ADD COLUMN "manualOverrides" JSONB NOT NULL DEFAULT '{}'::jsonb;

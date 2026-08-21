UPDATE "effect_manifest_staged_files"
SET "matchedRowNumbers" = ARRAY[]::INTEGER[]
WHERE "matchedRowNumbers" IS NULL;

ALTER TABLE "effect_manifest_staged_files"
ALTER COLUMN "matchedRowNumbers" SET NOT NULL;

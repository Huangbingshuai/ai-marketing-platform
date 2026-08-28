CREATE TABLE "effect_extraction_image_cache" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "cacheKey" CHAR(64) NOT NULL,
    "candidate" JSONB NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "lastHitAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "effect_extraction_image_cache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "effect_extraction_image_cache_projectId_cacheKey_key"
ON "effect_extraction_image_cache"("projectId", "cacheKey");

CREATE INDEX "effect_extraction_image_cache_projectId_updatedAt_idx"
ON "effect_extraction_image_cache"("projectId", "updatedAt");

ALTER TABLE "effect_extraction_image_cache"
ADD CONSTRAINT "effect_extraction_image_cache_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

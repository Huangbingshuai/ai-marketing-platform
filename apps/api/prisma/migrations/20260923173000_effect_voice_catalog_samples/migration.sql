CREATE TABLE "effect_voice_catalog_samples" (
  "id" UUID NOT NULL,
  "profileId" VARCHAR(80) NOT NULL,
  "version" VARCHAR(100) NOT NULL,
  "storageKey" VARCHAR(500) NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "mimeType" VARCHAR(120) NOT NULL,
  "duration" DOUBLE PRECISION NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "effect_voice_catalog_samples_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "effect_voice_catalog_samples_profileId_version_key"
  ON "effect_voice_catalog_samples"("profileId", "version");
CREATE UNIQUE INDEX "effect_voice_catalog_samples_storageKey_key"
  ON "effect_voice_catalog_samples"("storageKey");

CREATE TABLE "effect_voice_catalog_sample_attempts" (
  "id" UUID NOT NULL,
  "profileId" VARCHAR(80) NOT NULL,
  "version" VARCHAR(100) NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'SUBMITTED_UNKNOWN',
  "errorCode" VARCHAR(80),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "effect_voice_catalog_sample_attempts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "effect_voice_catalog_sample_attempts_profileId_version_key"
  ON "effect_voice_catalog_sample_attempts"("profileId", "version");

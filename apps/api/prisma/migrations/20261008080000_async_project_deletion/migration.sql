ALTER TABLE "projects"
  ADD COLUMN "deletionState" VARCHAR(20),
  ADD COLUMN "deletionError" VARCHAR(500);
ALTER TABLE "project_deletion_cleanups"
  ADD COLUMN "phase" VARCHAR(20) NOT NULL DEFAULT 'FILES',
  ADD COLUMN "status" VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
  ADD COLUMN "lastError" VARCHAR(500),
  ADD COLUMN "projectSnapshot" JSONB;

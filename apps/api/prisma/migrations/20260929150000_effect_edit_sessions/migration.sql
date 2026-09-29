ALTER TABLE "workflow_runs"
  ADD COLUMN "editBaselineHash" CHAR(64),
  ADD COLUMN "editSessionNodeId" VARCHAR(160),
  ADD COLUMN "editIdMap" JSONB;

ALTER TABLE "workflow_runs" ADD COLUMN "branchPublishedAt" TIMESTAMP(3);

-- Existing child rows were already visible before this migration.
UPDATE "workflow_runs"
SET "branchPublishedAt" = "createdAt"
WHERE "parentWorkflowRunId" IS NOT NULL;

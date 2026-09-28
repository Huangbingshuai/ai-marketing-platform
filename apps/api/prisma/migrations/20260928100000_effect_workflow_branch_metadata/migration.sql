ALTER TABLE "workflow_runs"
  ADD COLUMN "parentWorkflowRunId" UUID,
  ADD COLUMN "forkNodeId" VARCHAR(160),
  ADD COLUMN "forkTemplateId" VARCHAR(160),
  ADD COLUMN "branchLabel" VARCHAR(160);

CREATE INDEX "workflow_runs_projectId_workflow_workflowSpace_parentWorkflowRunId_idx"
  ON "workflow_runs"("projectId", "workflow", "workflowSpace", "parentWorkflowRunId");

ALTER TABLE "workflow_runs"
  ADD CONSTRAINT "workflow_runs_projectId_parentWorkflowRunId_fkey"
  FOREIGN KEY ("projectId", "parentWorkflowRunId")
  REFERENCES "workflow_runs"("projectId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- An effect branch owns its import workspace and mode drafts. Existing rows keep
-- their IDs and become the initial trunk; no historical branch is inferred.
DROP INDEX IF EXISTS "effect_import_workspaces_projectId_key";
CREATE INDEX "effect_import_workspaces_projectId_updatedAt_idx"
  ON "effect_import_workspaces"("projectId", "updatedAt");
DROP INDEX IF EXISTS "effect_import_drafts_projectId_mode_key";
CREATE UNIQUE INDEX "effect_import_drafts_workspaceId_mode_key"
  ON "effect_import_drafts"("workspaceId", "mode");

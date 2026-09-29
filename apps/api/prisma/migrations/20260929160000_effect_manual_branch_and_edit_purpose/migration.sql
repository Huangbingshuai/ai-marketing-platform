ALTER TABLE "workflow_runs"
  ADD COLUMN "branchCreationKey" VARCHAR(160),
  ADD COLUMN "editSessionPurpose" VARCHAR(32);

CREATE UNIQUE INDEX "workflow_runs_project_workflow_space_branch_creation_key"
  ON "workflow_runs"("projectId", "workflow", "workflowSpace", "branchCreationKey");

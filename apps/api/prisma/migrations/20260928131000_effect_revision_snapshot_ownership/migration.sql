ALTER TABLE "working_artifact_revision_snapshots"
  ADD CONSTRAINT "working_artifact_revisions_project_fkey"
  FOREIGN KEY ("projectId") REFERENCES "projects"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "working_artifact_revision_snapshots"
  ADD CONSTRAINT "working_artifact_revisions_run_fkey"
  FOREIGN KEY ("projectId", "workflowRunId")
  REFERENCES "workflow_runs"("projectId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

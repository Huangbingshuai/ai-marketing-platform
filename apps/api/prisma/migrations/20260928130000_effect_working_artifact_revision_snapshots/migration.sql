CREATE TABLE "working_artifact_revision_snapshots" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "workflowRunId" UUID NOT NULL,
  "workingArtifactId" UUID NOT NULL,
  "nodeId" VARCHAR(160) NOT NULL,
  "artifactKey" VARCHAR(500) NOT NULL,
  "revision" INTEGER NOT NULL,
  "contentHash" CHAR(64) NOT NULL,
  "snapshot" JSONB NOT NULL,
  "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "working_artifact_revision_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "working_artifact_revisions_scope_key"
  ON "working_artifact_revision_snapshots"("projectId", "workflowRunId", "nodeId", "artifactKey", "revision");
CREATE INDEX "working_artifact_revisions_artifact_idx"
  ON "working_artifact_revision_snapshots"("projectId", "workingArtifactId", "revision");

CREATE TABLE "working_artifact_revision_files" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "workflowRunId" UUID NOT NULL,
  "snapshotId" UUID NOT NULL,
  "fileObjectId" UUID NOT NULL,
  "role" VARCHAR(80) NOT NULL,
  "sortOrder" INTEGER NOT NULL,
  CONSTRAINT "working_artifact_revision_files_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "working_artifact_revision_files_binding_key"
  ON "working_artifact_revision_files"("snapshotId", "fileObjectId", "role", "sortOrder");
CREATE INDEX "working_artifact_revision_files_lookup_idx"
  ON "working_artifact_revision_files"("projectId", "fileObjectId");
ALTER TABLE "working_artifact_revision_files"
  ADD CONSTRAINT "working_artifact_revision_files_snapshot_fkey"
  FOREIGN KEY ("snapshotId") REFERENCES "working_artifact_revision_snapshots"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "working_artifact_revision_files"
  ADD CONSTRAINT "working_artifact_revision_files_file_fkey"
  FOREIGN KEY ("projectId", "workflowRunId", "fileObjectId")
  REFERENCES "file_objects"("projectId", "workflowRunId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

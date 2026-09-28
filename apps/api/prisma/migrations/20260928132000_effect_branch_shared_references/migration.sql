-- A branch may reference an ancestor's immutable artifact or media object, but
-- every reference remains inside the same project. Application validation
-- restricts the allowed ancestor chain before inserting these links.
ALTER TABLE "working_artifact_files"
  DROP CONSTRAINT "working_artifact_files_same_run_file_fkey",
  ADD CONSTRAINT "working_artifact_files_project_file_fkey"
    FOREIGN KEY ("projectId", "fileObjectId")
    REFERENCES "file_objects"("projectId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "working_artifact_revision_files"
  DROP CONSTRAINT "working_artifact_revision_files_file_fkey",
  ADD CONSTRAINT "working_artifact_revision_files_project_file_fkey"
    FOREIGN KEY ("projectId", "fileObjectId")
    REFERENCES "file_objects"("projectId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "effect_import_materials"
  DROP CONSTRAINT "effect_import_materials_same_run_file_fkey",
  ADD CONSTRAINT "effect_import_materials_project_file_fkey"
    FOREIGN KEY ("projectId", "fileObjectId")
    REFERENCES "file_objects"("projectId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "working_artifact_dependencies"
  DROP CONSTRAINT "working_artifact_dependencies_same_run_source_fkey",
  ADD CONSTRAINT "working_artifact_dependencies_project_source_fkey"
    FOREIGN KEY ("projectId", "sourceArtifactId")
    REFERENCES "working_artifacts"("projectId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

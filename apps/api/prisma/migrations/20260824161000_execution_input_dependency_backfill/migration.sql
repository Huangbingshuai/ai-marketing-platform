-- The enum value was introduced in the previous migration so PostgreSQL can
-- safely use it here after the enum-altering transaction has committed.
UPDATE "working_artifact_dependencies" d
SET "sourceType" = 'EXECUTION_INPUT',
    "sourceHash" = s."executionInputHash",
    "sourceRevision" = NULL
FROM "workflow_node_states" s
WHERE d."sourceType" = 'NODE_STATE'
  AND d."projectId" = s."projectId"
  AND d."workflowRunId" = s."workflowRunId"
  AND COALESCE(d."sourceNodeId", d."sourceKey") = s."nodeId";

UPDATE "working_artifacts" a
SET "freshness" = 'STALE'
WHERE EXISTS (
  SELECT 1
  FROM "working_artifact_dependencies" d
  WHERE d."dependentArtifactId" = a."id"
    AND d."projectId" = a."projectId"
    AND d."workflowRunId" = a."workflowRunId"
    AND d."sourceType" = 'NODE_STATE'
);

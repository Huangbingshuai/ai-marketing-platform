-- Creation is serialized by the project/Run/template advisory lock and mix-node
-- row lock. The repository checks active target variants under those locks.
-- A template-wide unique index cannot represent disjoint SINGLE_PACKAGE jobs.
DROP INDEX IF EXISTS "effect_packaging_runs_active_idx";

CREATE INDEX "effect_packaging_runs_active_lookup_idx"
ON "effect_packaging_runs"("projectId", "workflowRunId", "templateId")
WHERE "status" IN ('QUEUED', 'RUNNING');

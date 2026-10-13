CREATE TABLE "customized_production_tasks" (
 "id" UUID NOT NULL, "projectId" UUID NOT NULL, "workflowRunId" UUID NOT NULL,
 "operation" VARCHAR(24) NOT NULL, "shotId" VARCHAR(200), "idempotencyKey" VARCHAR(200) NOT NULL,
 "status" VARCHAR(24) NOT NULL DEFAULT 'QUEUED', "inputSnapshot" JSONB NOT NULL,
 "steps" JSONB NOT NULL, "output" JSONB, "attemptToken" UUID, "attemptCount" INTEGER NOT NULL DEFAULT 0,
 "leaseExpiresAt" TIMESTAMP(3), "errorMessage" VARCHAR(1000),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "customized_production_tasks_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "customized_production_tasks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "customized_production_tasks_run_fkey" FOREIGN KEY ("projectId", "workflowRunId") REFERENCES "workflow_runs"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "customized_production_tasks_projectId_idempotencyKey_key" ON "customized_production_tasks"("projectId", "idempotencyKey");
CREATE INDEX "customized_production_tasks_projectId_workflowRunId_createdAt_idx" ON "customized_production_tasks"("projectId", "workflowRunId", "createdAt");
CREATE INDEX "customized_production_tasks_status_leaseExpiresAt_idx" ON "customized_production_tasks"("status", "leaseExpiresAt");

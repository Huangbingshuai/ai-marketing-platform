-- CreateTable
CREATE TABLE "customized_extraction_tasks" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "workflowRunId" UUID NOT NULL,
    "idempotencyKey" VARCHAR(500) NOT NULL,
    "inputHash" CHAR(64) NOT NULL,
    "inputSnapshot" JSONB NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'QUEUED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "currentNode" VARCHAR(120),
    "errorMessage" VARCHAR(1000),
    "attemptToken" UUID,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "leaseExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customized_extraction_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customized_extraction_steps" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "nodeId" VARCHAR(120) NOT NULL,
    "sourceId" VARCHAR(255) NOT NULL DEFAULT '',
    "status" VARCHAR(24) NOT NULL DEFAULT 'PENDING',
    "output" JSONB,
    "errorMessage" VARCHAR(1000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customized_extraction_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customized_extraction_results" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "workflowRunId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "sourceFingerprint" CHAR(64) NOT NULL,
    "generatedResult" JSONB NOT NULL,
    "draftResult" JSONB NOT NULL,
    "manualOverrides" JSONB NOT NULL DEFAULT '{}',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customized_extraction_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customized_extraction_artifacts" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "sourceId" VARCHAR(255) NOT NULL,
    "storageKey" VARCHAR(500) NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customized_extraction_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customized_extraction_file_holds" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "storageKey" VARCHAR(500) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customized_extraction_file_holds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customized_extraction_tasks_projectId_workflowRunId_created_idx" ON "customized_extraction_tasks"("projectId", "workflowRunId", "createdAt");

-- CreateIndex
CREATE INDEX "customized_extraction_tasks_status_leaseExpiresAt_idx" ON "customized_extraction_tasks"("status", "leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "customized_extraction_tasks_projectId_id_key" ON "customized_extraction_tasks"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "customized_extraction_tasks_projectId_idempotencyKey_key" ON "customized_extraction_tasks"("projectId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "customized_extraction_steps_projectId_taskId_nodeId_sourceI_key" ON "customized_extraction_steps"("projectId", "taskId", "nodeId", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "customized_extraction_results_projectId_id_key" ON "customized_extraction_results"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "customized_extraction_results_projectId_workflowRunId_key" ON "customized_extraction_results"("projectId", "workflowRunId");

-- CreateIndex
CREATE UNIQUE INDEX "customized_extraction_artifacts_projectId_taskId_sourceId_key" ON "customized_extraction_artifacts"("projectId", "taskId", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "customized_extraction_file_holds_projectId_taskId_storageKe_key" ON "customized_extraction_file_holds"("projectId", "taskId", "storageKey");

-- AddForeignKey
ALTER TABLE "customized_extraction_tasks" ADD CONSTRAINT "customized_extraction_tasks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customized_extraction_tasks" ADD CONSTRAINT "customized_extraction_tasks_workflowRunId_fkey" FOREIGN KEY ("workflowRunId") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customized_extraction_steps" ADD CONSTRAINT "customized_extraction_steps_projectId_taskId_fkey" FOREIGN KEY ("projectId", "taskId") REFERENCES "customized_extraction_tasks"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customized_extraction_results" ADD CONSTRAINT "customized_extraction_results_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customized_extraction_results" ADD CONSTRAINT "customized_extraction_results_workflowRunId_fkey" FOREIGN KEY ("workflowRunId") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customized_extraction_artifacts" ADD CONSTRAINT "customized_extraction_artifacts_projectId_taskId_fkey" FOREIGN KEY ("projectId", "taskId") REFERENCES "customized_extraction_tasks"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customized_extraction_file_holds" ADD CONSTRAINT "customized_extraction_file_holds_projectId_taskId_fkey" FOREIGN KEY ("projectId", "taskId") REFERENCES "customized_extraction_tasks"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

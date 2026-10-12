-- AlterTable
ALTER TABLE "workflow_runs" ADD COLUMN     "forkScriptId" UUID;

-- CreateTable
CREATE TABLE "customized_storyboard_tasks" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "workflowRunId" UUID NOT NULL,
    "idempotencyKey" VARCHAR(200) NOT NULL,
    "inputHash" CHAR(64) NOT NULL,
    "inputSnapshot" JSONB NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'QUEUED',
    "attemptToken" UUID,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "leaseExpiresAt" TIMESTAMP(3),
    "errorMessage" VARCHAR(1000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customized_storyboard_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customized_storyboard_steps" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "nodeId" VARCHAR(40) NOT NULL,
    "scriptId" VARCHAR(40) NOT NULL DEFAULT '',
    "status" VARCHAR(24) NOT NULL DEFAULT 'PENDING',
    "output" JSONB,
    "errorMessage" VARCHAR(1000),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customized_storyboard_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customized_storyboard_scripts" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "sourceRunId" UUID NOT NULL,
    "workflowRunId" UUID,
    "taskId" UUID,
    "sourceSnapshot" JSONB NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'DRAFT',
    "origin" VARCHAR(24) NOT NULL DEFAULT 'MANUAL',
    "draft" JSONB NOT NULL,
    "generated" JSONB,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "editing" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customized_storyboard_scripts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customized_storyboard_tasks_projectId_workflowRunId_created_idx" ON "customized_storyboard_tasks"("projectId", "workflowRunId", "createdAt");

-- CreateIndex
CREATE INDEX "customized_storyboard_tasks_status_leaseExpiresAt_idx" ON "customized_storyboard_tasks"("status", "leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "customized_storyboard_tasks_projectId_id_key" ON "customized_storyboard_tasks"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "customized_storyboard_tasks_projectId_idempotencyKey_key" ON "customized_storyboard_tasks"("projectId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "customized_storyboard_steps_projectId_taskId_nodeId_scriptI_key" ON "customized_storyboard_steps"("projectId", "taskId", "nodeId", "scriptId");

-- CreateIndex
CREATE INDEX "customized_storyboard_scripts_projectId_sourceRunId_created_idx" ON "customized_storyboard_scripts"("projectId", "sourceRunId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "customized_storyboard_scripts_projectId_id_key" ON "customized_storyboard_scripts"("projectId", "id");

-- AddForeignKey
ALTER TABLE "customized_storyboard_tasks" ADD CONSTRAINT "customized_storyboard_tasks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customized_storyboard_tasks" ADD CONSTRAINT "customized_storyboard_tasks_workflowRunId_fkey" FOREIGN KEY ("workflowRunId") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customized_storyboard_steps" ADD CONSTRAINT "customized_storyboard_steps_projectId_taskId_fkey" FOREIGN KEY ("projectId", "taskId") REFERENCES "customized_storyboard_tasks"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customized_storyboard_scripts" ADD CONSTRAINT "customized_storyboard_scripts_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customized_storyboard_scripts" ADD CONSTRAINT "customized_storyboard_scripts_workflowRunId_fkey" FOREIGN KEY ("workflowRunId") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customized_storyboard_scripts" ADD CONSTRAINT "customized_storyboard_scripts_projectId_taskId_fkey" FOREIGN KEY ("projectId", "taskId") REFERENCES "customized_storyboard_tasks"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

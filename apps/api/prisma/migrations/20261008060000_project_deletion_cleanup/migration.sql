CREATE TABLE "project_deletion_cleanups" (
    "projectId" UUID NOT NULL,
    "storageKeys" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseToken" UUID,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "project_deletion_cleanups_pkey" PRIMARY KEY ("projectId")
);
CREATE INDEX "project_deletion_cleanups_nextAttemptAt_idx" ON "project_deletion_cleanups"("nextAttemptAt");

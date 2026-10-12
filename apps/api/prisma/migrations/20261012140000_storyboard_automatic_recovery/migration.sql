ALTER TABLE "customized_storyboard_tasks"
ADD COLUMN "autoRetryScriptIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

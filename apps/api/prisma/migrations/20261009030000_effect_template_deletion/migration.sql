CREATE TABLE effect_template_deletions (
  id uuid PRIMARY KEY,
  "projectId" uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  "templateId" uuid NOT NULL,
  "workflowRunIds" uuid[] NOT NULL DEFAULT '{}',
  "fallbackRunId" uuid NOT NULL,
  "storageKeys" jsonb NOT NULL DEFAULT '[]',
  phase varchar(20) NOT NULL DEFAULT 'DATABASE',
  status varchar(20) NOT NULL DEFAULT 'QUEUED',
  attempts integer NOT NULL DEFAULT 0,
  "leaseToken" uuid,
  "lastError" varchar(500),
  "nextAttemptAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("projectId", "templateId")
);
CREATE INDEX effect_template_deletions_pending_idx ON effect_template_deletions(status, "nextAttemptAt");

-- A permanent identity tombstone protects all writers, including old worker protocols.
-- DELETE remains allowed for background cleanup. Cancellation is allowed but cannot revive tasks.
CREATE FUNCTION reject_deleted_effect_template_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_data jsonb := to_jsonb(NEW); deleted boolean;
BEGIN
  -- Project-wide permanent cleanup detaches Restrict parent links before cascades.
  -- Permit only that structural update, never a task/artifact resurrection.
  IF TG_TABLE_NAME = 'workflow_runs' AND TG_OP = 'UPDATE'
    AND row_data->>'parentWorkflowRunId' IS NULL
    AND (row_data - 'parentWorkflowRunId' - 'updatedAt') = (to_jsonb(OLD) - 'parentWorkflowRunId' - 'updatedAt')
    AND EXISTS(SELECT 1 FROM projects p WHERE p.id = (row_data->>'projectId')::uuid AND to_jsonb(p)->>'deletionState' IN ('QUEUED', 'RUNNING')) THEN
    RETURN NEW;
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM effect_template_deletions d WHERE d."projectId" = (row_data->>'projectId')::uuid
    AND (
      d."templateId"::text = row_data->>'templateId'
      OR d."templateId"::text = row_data->>'forkTemplateId'
      OR (row_data->>'artifactKey') ~ ('^(mix-template|timeline-project|timeline-package|final-delivery|final-video):' || d."templateId"::text || '(:|$)')
      OR (row_data->>'workflowRunId')::uuid = ANY(d."workflowRunIds")
      OR (TG_TABLE_NAME = 'workflow_runs' AND ((row_data->>'id')::uuid = ANY(d."workflowRunIds")
          OR ((row_data->>'parentWorkflowRunId')::uuid = ANY(d."workflowRunIds")
            AND (TG_OP = 'INSERT' OR row_data->>'parentWorkflowRunId' IS DISTINCT FROM to_jsonb(OLD)->>'parentWorkflowRunId'))))
      OR (TG_TABLE_NAME = 'workflow_node_states' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(row_data->'state'->'templates') = 'array'
          THEN row_data->'state'->'templates' ELSE '[]'::jsonb END) entry
        WHERE entry->>'id' = d."templateId"::text))
      OR (TG_TABLE_NAME = 'workflow_node_states' AND (row_data->'state'->'selectedTemplates') ? d."templateId"::text)
      OR (TG_TABLE_NAME = 'effect_packaging_items' AND EXISTS (
        SELECT 1 FROM effect_packaging_runs r WHERE r.id::text = row_data->>'runId' AND r."projectId" = d."projectId" AND r."templateId" = d."templateId"))
      OR (TG_TABLE_NAME = 'effect_packaging_files' AND EXISTS (
        SELECT 1 FROM effect_packaging_items i JOIN effect_packaging_runs r ON r.id = i."runId" AND r."projectId" = i."projectId"
        WHERE i.id::text = row_data->>'itemId' AND r."projectId" = d."projectId" AND r."templateId" = d."templateId"))
      OR (TG_TABLE_NAME = 'effect_final_output_items' AND EXISTS (
        SELECT 1 FROM effect_final_output_runs r WHERE r.id::text = row_data->>'runId' AND r."projectId" = d."projectId" AND r."templateId" = d."templateId"))
      OR (TG_TABLE_NAME = 'assets' AND (row_data->>'sourceRunId') = ANY(d."workflowRunIds"::text[]))
      OR (TG_TABLE_NAME = 'assets' AND (
        (row_data->>'sourceArtifactId') ~ ('^(mix-template|timeline-project|timeline-package|final-delivery|final-video):' || d."templateId"::text || '(:|$)')
        OR EXISTS(SELECT 1 FROM working_artifacts a WHERE a."projectId" = d."projectId"
          AND a.id::text = row_data->>'sourceArtifactId'
          AND a."artifactKey" ~ ('^(mix-template|timeline-project|timeline-package|final-delivery|final-video):' || d."templateId"::text || '(:|$)'))
      ))
    )
  ) INTO deleted;
  IF deleted AND NOT (TG_OP = 'UPDATE' AND COALESCE(row_data->>'status', '') = 'CANCELLED') THEN
    RAISE EXCEPTION 'EFFECT_TEMPLATE_DELETED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['workflow_runs', 'workflow_node_states', 'working_artifacts',
    'working_artifact_revision_snapshots', 'effect_template_mix_ai_runs', 'effect_packaging_runs',
    'effect_final_output_runs', 'effect_packaging_items', 'effect_packaging_files',
    'effect_final_output_items', 'assets', 'file_objects'] LOOP
    EXECUTE format('CREATE TRIGGER effect_template_deletion_guard BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION reject_deleted_effect_template_write()', table_name);
  END LOOP;
END $$;

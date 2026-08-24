-- Normalize the compatibility backfill to the same projection produced by the runtime.
-- This is separate because the initial compatibility migration may already be deployed.
WITH product_projection AS (
  SELECT
    p."projectId",
    w."workflowRunId",
    p."id" AS "productId",
    CASE
      WHEN btrim(p."name") <> '' THEN btrim(p."name")
      ELSE '商品资料包 ' || lpad((p."sortOrder" + 1)::text, 2, '0')
    END AS "productName",
    p."category",
    p."sku",
    p."commerceUrl",
    EXISTS (
      SELECT 1
      FROM "effect_import_materials" m
      WHERE m."projectId" = p."projectId"
        AND m."productId" = p."id"
        AND m."status" = 'READY'
        AND m."fileObjectId" IS NOT NULL
    ) AS "hasFiles"
  FROM "effect_import_products" p
  JOIN "effect_import_drafts" d
    ON d."projectId" = p."projectId" AND d."id" = p."draftId"
  JOIN "effect_import_workspaces" w
    ON w."projectId" = d."projectId" AND w."id" = d."workspaceId"
)
UPDATE "working_artifacts" a
SET
  "name" = left(pp."productName" || ' 原始资料包', 120),
  "tags" = ARRAY(
    SELECT DISTINCT value
    FROM unnest(ARRAY[pp."productName", pp."category", pp."sku"]) AS value
    WHERE btrim(value) <> ''
  ),
  "payload" = jsonb_build_object(
    'productId', pp."productId",
    'productName', pp."productName",
    'category', pp."category",
    'sku', pp."sku",
    'commerceUrl', pp."commerceUrl",
    'completeness', CASE WHEN pp."hasFiles" THEN 'WORKING' ELSE 'INCOMPLETE' END
  ),
  "metadata" = COALESCE(a."metadata", '{}'::jsonb)
    || jsonb_build_object('productId', pp."productId", 'productName', pp."productName"),
  "sourceArtifactId" = pp."productId"::text
FROM product_projection pp
WHERE a."projectId" = pp."projectId"
  AND a."workflowRunId" = pp."workflowRunId"
  AND a."nodeId" = 'SOURCE_IMPORT'
  AND a."artifactKey" = 'source-package:' || pp."productId"::text;

WITH product_projection AS (
  SELECT
    p."projectId",
    w."workflowRunId",
    p."id" AS "productId",
    CASE
      WHEN btrim(p."name") <> '' THEN btrim(p."name")
      ELSE '商品资料包 ' || lpad((p."sortOrder" + 1)::text, 2, '0')
    END AS "productName"
  FROM "effect_import_products" p
  JOIN "effect_import_drafts" d
    ON d."projectId" = p."projectId" AND d."id" = p."draftId"
  JOIN "effect_import_workspaces" w
    ON w."projectId" = d."projectId" AND w."id" = d."workspaceId"
)
UPDATE "working_artifacts" a
SET
  "name" = left(pp."productName" || ' 全局视频配置', 120),
  "tags" = ARRAY[pp."productName", '视频配置'],
  "metadata" = jsonb_build_object('productId', pp."productId", 'productName', pp."productName"),
  "sourceArtifactId" = pp."productId"::text
FROM product_projection pp
WHERE a."projectId" = pp."projectId"
  AND a."workflowRunId" = pp."workflowRunId"
  AND a."nodeId" = 'SOURCE_IMPORT'
  AND a."artifactKey" = 'global-video-config:' || pp."productId"::text;

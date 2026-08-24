import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';

import { Client as MinioClient } from 'minio';
import { Client as PgClient } from 'pg';

const rootEnvPath = resolve(process.cwd(), '../../.env');
const localStorageRoot = resolve(process.cwd(), '../../.local-storage');
if (existsSync(rootEnvPath)) {
  for (const line of readFileSync(rootEnvPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    const raw = match[2].replace(/^(['"])(.*)\1$/, '$2');
    process.env[match[1]] = raw;
  }
}

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const apply = process.argv.includes('--apply');
const bucket = required('MINIO_BUCKET');
const minioClient = new MinioClient({
  endPoint: required('MINIO_ENDPOINT'),
  port: Number(required('MINIO_PORT')),
  useSSL: required('MINIO_USE_SSL').toLowerCase() === 'true',
  accessKey: required('MINIO_ACCESS_KEY'),
  secretKey: required('MINIO_SECRET_KEY'),
});
const database = new PgClient({ connectionString: required('DATABASE_URL') });

const lifecycleSegments = {
  staging: '01-staging',
  assets: '02-assets',
  manifest: '03-manifest',
};
const categories = {
  PRODUCT_IMAGE: '商品图片',
  PRODUCT_DOCUMENT: '产品文档',
  SOURCE_MATERIAL: '原始资料',
  REFERENCE_VIDEO: '参考视频',
  VIDEO_CONFIG: '视频配置',
  PRODUCT_PROFILE: '产品资料',
  PROMPT: 'Prompt',
  VIDEO: '视频',
  AUDIO: '音频',
  IMAGE: '图片',
  DOCUMENT: '文档',
};

const cleanSegment = (value, fallback, maxLength = 80) => {
  const cleaned = String(value ?? '')
    .normalize('NFKC')
    .split('')
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join('')
    .replace(/[\\/:*?"<>|%]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, maxLength)
    .replace(/[.\s]+$/g, '');
  return cleaned || fallback;
};
const shortId = (value) => cleanSegment(String(value ?? '').slice(0, 8), 'unknown', 8);
const namedIdentity = (name, id, fallback) =>
  !String(name ?? '').trim() && !String(id ?? '').trim()
    ? fallback
    : `${cleanSegment(name, fallback)}__${shortId(id)}`;
const deterministicObjectId = (oldKey) => {
  const found = [
    ...oldKey.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi),
  ].at(-1);
  if (found) return found[0].toLowerCase();
  const hash = createHash('sha256').update(oldKey).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};
const buildKey = (row) => {
  const originalName = String(row.originalFileName || '文件').replace(/^.*[\\/]/, '');
  const extension = extname(originalName);
  const stem = extension ? originalName.slice(0, -extension.length) : originalName;
  const safeExtension = extension
    ? `.${cleanSegment(extension.slice(1), 'bin', 12).toLowerCase()}`
    : '';
  const fileName = `${cleanSegment(stem, '文件', 120)}__${deterministicObjectId(row.oldKey)}${safeExtension}`;
  return [
    'projects',
    namedIdentity(row.projectName, row.projectId, '未命名项目'),
    cleanSegment(String(row.workflow || 'effect').toLowerCase(), 'unknown-workflow', 32),
    lifecycleSegments[row.lifecycle],
    namedIdentity(row.productName, row.productId, '未归属产品'),
    cleanSegment(categories[row.category] || row.category, '其他资料'),
    fileName,
  ].join('/');
};

const descriptorSql = `
  SELECT DISTINCT ON ("oldKey") *
  FROM (
    SELECT
      material."storageKey" AS "oldKey",
      material."projectId"::text AS "projectId",
      project.name AS "projectName",
      'effect' AS workflow,
      'staging' AS lifecycle,
      product.id::text AS "productId",
      COALESCE(NULLIF(product.name, ''), NULLIF(project."productName", ''), '未命名产品') AS "productName",
      material.type::text AS category,
      COALESCE(source_asset."originalFileName", material."originalFileName", material."expectedFileName", '文件') AS "originalFileName",
      1 AS priority
    FROM effect_import_materials material
    JOIN effect_import_products product
      ON product."projectId" = material."projectId" AND product.id = material."productId"
    JOIN projects project ON project.id = material."projectId"
    LEFT JOIN assets source_asset
      ON source_asset."projectId" = material."projectId"
      AND source_asset."sourceArtifactId" = material.id::text
      AND source_asset."hasFile" = true
    WHERE material."storageKey" IS NOT NULL

    UNION ALL

    SELECT
      asset."storageKey" AS "oldKey",
      asset."projectId"::text AS "projectId",
      project.name AS "projectName",
      lower(asset."storageWorkflow"::text) AS workflow,
      'assets' AS lifecycle,
      COALESCE(asset."businessData"->>'productId', source_product.id::text) AS "productId",
      COALESCE(
        NULLIF(asset."businessData"->>'productName', ''),
        NULLIF(source_product.name, ''),
        NULLIF(project."productName", ''),
        '未命名产品'
      ) AS "productName",
      asset.type::text AS category,
      asset."originalFileName" AS "originalFileName",
      2 AS priority
    FROM assets asset
    JOIN projects project ON project.id = asset."projectId"
    LEFT JOIN effect_import_materials source_material
      ON source_material."projectId" = asset."projectId"
      AND source_material.id::text = asset."sourceArtifactId"
    LEFT JOIN effect_import_products source_product
      ON source_product."projectId" = source_material."projectId"
      AND source_product.id = source_material."productId"
    WHERE asset."hasFile" = true AND asset."storageKey" <> ''

    UNION ALL

    SELECT
      staged."storageKey" AS "oldKey",
      staged."projectId"::text AS "projectId",
      project.name AS "projectName",
      'effect' AS workflow,
      'manifest' AS lifecycle,
      NULL AS "productId",
      NULL AS "productName",
      '清单配套文件' AS category,
      staged."originalFileName" AS "originalFileName",
      3 AS priority
    FROM effect_manifest_staged_files staged
    JOIN projects project ON project.id = staged."projectId"
  ) descriptors
  WHERE "oldKey" NOT LIKE '%/01-staging/%'
    AND "oldKey" NOT LIKE '%/02-assets/%'
    AND "oldKey" NOT LIKE '%/03-manifest/%'
  ORDER BY "oldKey", priority
`;

const statOrNull = async (key) => {
  try {
    return await minioClient.statObject(bucket, key);
  } catch (error) {
    if (error?.code === 'NotFound' || error?.code === 'NoSuchKey') return null;
    throw error;
  }
};
const listLegacyLayoutKeys = () =>
  new Promise((resolveList, rejectList) => {
    const keys = [];
    const objects = minioClient.listObjectsV2(bucket, '', true);
    objects.on('data', (item) => {
      const key = item.name ?? item.prefix;
      if (
        key &&
        (/^assets\//.test(key) ||
          /^projects\/[0-9a-f-]{36}\/assets\/[0-9a-f]{2}\/[0-9a-f-]{36}$/i.test(key))
      ) {
        keys.push(key);
      }
    });
    objects.on('error', rejectList);
    objects.on('end', () => resolveList(keys));
  });
const replaceJsonValues = (value, replacements) => {
  if (typeof value === 'string') return replacements.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => replaceJsonValues(item, replacements));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, replaceJsonValues(item, replacements)]),
  );
};

await database.connect();
const copied = [];
try {
  const { rows } = await database.query(descriptorSql);
  const migrations = rows.map((row) => ({ ...row, newKey: buildKey(row) }));
  console.log(
    `${apply ? 'APPLY' : 'DRY RUN'}: ${migrations.length} referenced object(s) require migration.`,
  );
  for (const item of migrations) console.log(`${item.oldKey}\n  -> ${item.newKey}`);
  if (!apply || migrations.length === 0) process.exitCode = 0;
  else {
    for (const item of migrations) {
      const minioSource = await statOrNull(item.oldKey);
      const localSourcePath = resolve(localStorageRoot, item.oldKey);
      const hasLocalSource =
        localSourcePath.startsWith(`${localStorageRoot}\\`) && existsSync(localSourcePath);
      const source = minioSource ?? (hasLocalSource ? statSync(localSourcePath) : null);
      if (!source) {
        throw new Error(
          `Referenced object is missing from MinIO and .local-storage: ${item.oldKey}`,
        );
      }
      const existingDestination = await statOrNull(item.newKey);
      if (existingDestination && existingDestination.size !== source.size) {
        throw new Error(`Destination exists with a different size: ${item.newKey}`);
      }
      if (!existingDestination) {
        if (minioSource) {
          await minioClient.copyObject(bucket, item.newKey, `/${bucket}/${item.oldKey}`);
        } else {
          await minioClient.putObject(
            bucket,
            item.newKey,
            createReadStream(localSourcePath),
            source.size,
            { 'Content-Type': 'application/octet-stream' },
          );
        }
        copied.push(item.newKey);
      }
      const destination = await minioClient.statObject(bucket, item.newKey);
      if (destination.size !== source.size) throw new Error(`Copy size mismatch: ${item.oldKey}`);
    }

    const replacements = new Map(migrations.map((item) => [item.oldKey, item.newKey]));
    await database.query('BEGIN');
    try {
      const tables = [
        'assets',
        'asset_versions',
        'effect_import_materials',
        'effect_import_publish_file_holds',
        'storage_cleanup_tasks',
        'effect_manifest_staged_files',
      ];
      for (const { oldKey, newKey } of migrations) {
        for (const table of tables) {
          await database.query(`UPDATE ${table} SET "storageKey" = $2 WHERE "storageKey" = $1`, [
            oldKey,
            newKey,
          ]);
        }
      }
      const operations = await database.query(
        'SELECT id::text, snapshot FROM effect_import_publish_operations',
      );
      for (const operation of operations.rows) {
        const snapshot = replaceJsonValues(operation.snapshot, replacements);
        if (JSON.stringify(snapshot) !== JSON.stringify(operation.snapshot)) {
          await database.query(
            'UPDATE effect_import_publish_operations SET snapshot = $2::jsonb WHERE id = $1::uuid',
            [operation.id, JSON.stringify(snapshot)],
          );
        }
      }
      await database.query('COMMIT');
    } catch (error) {
      await database.query('ROLLBACK');
      throw error;
    }

    const removeFailures = [];
    for (const { oldKey } of migrations) {
      try {
        await minioClient.removeObject(bucket, oldKey);
      } catch (error) {
        removeFailures.push({ oldKey, error });
      }
    }
    if (removeFailures.length) {
      console.warn(
        `${removeFailures.length} old object(s) could not be removed; new references are valid.`,
      );
      for (const failure of removeFailures) console.warn(failure.oldKey);
    }
    console.log(
      `Migrated ${migrations.length} object(s); removed ${migrations.length - removeFailures.length} old key(s).`,
    );
  }
  let remainingLegacyKeys = await listLegacyLayoutKeys();
  if (apply && remainingLegacyKeys.length) {
    const cleanedHistoricalKeys = [];
    for (const key of remainingLegacyKeys) {
      const referenceCheck = await database.query(
        `SELECT
          (SELECT count(*)::int FROM assets WHERE "storageKey" = $1) AS assets,
          (SELECT count(*)::int FROM effect_import_materials WHERE "storageKey" = $1) AS materials,
          (SELECT count(*)::int FROM effect_import_publish_file_holds WHERE "storageKey" = $1) AS holds,
          (SELECT count(*)::int FROM storage_cleanup_tasks WHERE "storageKey" = $1) AS cleanup,
          (SELECT count(*)::int FROM effect_manifest_staged_files WHERE "storageKey" = $1) AS manifests,
          (SELECT count(*)::int
             FROM asset_versions version
             JOIN assets asset
               ON asset.id = version."assetId" AND asset."projectId" = version."projectId"
            WHERE version."storageKey" = $1
              AND version.version < asset."currentVersion"
              AND asset."storageKey" <> $1) AS "staleVersions",
          (SELECT count(*)::int FROM asset_versions WHERE "storageKey" = $1) AS versions`,
        [key],
      );
      const refs = referenceCheck.rows[0];
      const onlyStaleVersions =
        refs.versions > 0 &&
        refs.versions === refs.staleVersions &&
        refs.assets === 0 &&
        refs.materials === 0 &&
        refs.holds === 0 &&
        refs.cleanup === 0 &&
        refs.manifests === 0;
      if (!onlyStaleVersions) continue;
      await database.query('BEGIN');
      try {
        await database.query('DELETE FROM asset_versions WHERE "storageKey" = $1', [key]);
        await database.query('COMMIT');
      } catch (error) {
        await database.query('ROLLBACK');
        throw error;
      }
      await minioClient.removeObject(bucket, key);
      cleanedHistoricalKeys.push(key);
    }
    if (cleanedHistoricalKeys.length) {
      console.log(
        `Removed ${cleanedHistoricalKeys.length} obsolete historical-version object(s) and row(s).`,
      );
      remainingLegacyKeys = await listLegacyLayoutKeys();
    }
  }
  console.log(`Legacy-layout objects remaining in MinIO: ${remainingLegacyKeys.length}.`);
  for (const key of remainingLegacyKeys) console.log(`  ${key}`);
  const referencedObjects = await database.query(`
    SELECT DISTINCT "storageKey", "sizeBytes" FROM (
      SELECT "storageKey", "sizeBytes" FROM assets WHERE "hasFile" = true AND "storageKey" <> ''
      UNION ALL
      SELECT "storageKey", "sizeBytes" FROM asset_versions WHERE "storageKey" <> ''
      UNION ALL
      SELECT "storageKey", "sizeBytes" FROM effect_import_materials
        WHERE "storageKey" IS NOT NULL AND "sizeBytes" IS NOT NULL
      UNION ALL
      SELECT "storageKey", "sizeBytes" FROM effect_manifest_staged_files
    ) object_refs
  `);
  for (const reference of referencedObjects.rows) {
    const object = await statOrNull(reference.storageKey);
    if (!object) throw new Error(`Referenced MinIO object is missing: ${reference.storageKey}`);
    if (object.size !== reference.sizeBytes) {
      throw new Error(`Referenced MinIO object size mismatch: ${reference.storageKey}`);
    }
  }
  console.log(`Verified ${referencedObjects.rows.length} referenced MinIO object(s).`);
} catch (error) {
  if (copied.length) {
    await Promise.allSettled(copied.map((key) => minioClient.removeObject(bucket, key)));
  }
  throw error;
} finally {
  await database.end();
}

/** Resolve only known stable IDs, never a project-name or substring guess. */
export const projectStorageOwner = (key, projects) => {
  const [root, identity] = key.split('/');
  if (root !== 'projects' || !identity) return null;
  const matches = projects.filter(
    ({ id }) => identity === id || identity.endsWith(`__${id.slice(0, 8)}`),
  );
  if (matches.length > 1)
    throw Object.assign(new Error('Ambiguous project prefix'), {
      code: 'AMBIGUOUS_PROJECT_PREFIX',
    });
  return matches[0]?.id ?? null;
};

export const collectStorageOwners = async (database) => {
  const columns = await database.query(`
    SELECT c.table_name, c.column_name FROM information_schema.columns c
    WHERE c.table_schema='public' AND c.column_name ILIKE '%storagekey%'
      AND EXISTS (SELECT 1 FROM information_schema.columns p WHERE p.table_schema=c.table_schema AND p.table_name=c.table_name AND p.column_name='projectId')
  `);
  const owners = new Map();
  for (const { table_name: table, column_name: column } of columns.rows) {
    if (!/^[a-z_]+$/.test(table) || !/^[a-zA-Z]+$/.test(column))
      throw new Error('Invalid schema identifier');
    const records = await database.query(
      `SELECT "projectId", "${column}" AS key FROM "${table}" WHERE "${column}" IS NOT NULL`,
    );
    for (const row of records.rows) {
      if (!row.key) continue;
      const set = owners.get(row.key) ?? new Set();
      set.add(row.projectId);
      owners.set(row.key, set);
    }
  }
  return owners;
};

export const classifyStorageKey = (key, keepProjectId, projects, owners) => {
  const refs = owners.get(key);
  if (key.startsWith('shared/') || refs?.has(keepProjectId)) return 'KEEP';
  const owner = projectStorageOwner(key, projects);
  if (owner === keepProjectId) return 'KEEP';
  if (owner && projects.some(({ id }) => id === owner && id !== keepProjectId)) return 'DELETE';
  if (
    refs?.size &&
    [...refs].every((id) => projects.some((project) => project.id === id && id !== keepProjectId))
  )
    return 'DELETE';
  return 'UNKNOWN';
};

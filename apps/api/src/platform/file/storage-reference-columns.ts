// Typed storage-key columns shared by permanent cleanup workflows.
// JSON snapshots are not interpreted as deletable storage paths.
export const PROJECT_STORAGE_COLUMNS = [
  ['assets', 'storageKey'],
  ['asset_versions', 'storageKey'],
  ['working_artifacts', 'storageKey'],
  ['file_objects', 'storageKey'],
  ['effect_import_materials', 'storageKey'],
  ['effect_import_upload_items', 'storageKey'],
  ['storage_cleanup_tasks', 'storageKey'],
  ['effect_manifest_staged_files', 'storageKey'],
  ['effect_extraction_branch_outputs', 'textStorageKey'],
  ['effect_extraction_file_holds', 'storageKey'],
  ['effect_extraction_artifacts', 'storageKey'],
  ['effect_segment_import_drafts', 'storageKey'],
  ['effect_segment_render_tasks', 'outputStorageKey'],
  ['effect_segment_render_tasks', 'repairCandidateStorageKey'],
] as const;

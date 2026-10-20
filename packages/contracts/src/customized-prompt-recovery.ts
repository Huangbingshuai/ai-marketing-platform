/** Private task-output metadata. Created only by authenticated explicit retry, never by a model. */
export type ProductionPromptMechanicalRecovery = {
  version: 1;
  epoch: number;
  phase: 'audit' | 'recheck';
  history: Record<string, unknown>[];
};

export function isProductionPromptMechanicalRecovery(
  value: unknown,
): value is ProductionPromptMechanicalRecovery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as ProductionPromptMechanicalRecovery;
  return (
    Object.keys(v).every((key) => ['version', 'epoch', 'phase', 'history'].includes(key)) &&
    v.version === 1 &&
    Number.isSafeInteger(v.epoch) &&
    v.epoch > 0 &&
    (v.phase === 'audit' || v.phase === 'recheck') &&
    Array.isArray(v.history) &&
    v.history.every((entry) => !!entry && typeof entry === 'object' && !Array.isArray(entry))
  );
}

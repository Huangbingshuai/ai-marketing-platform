import {
  isProductionPromptMechanicalRecovery,
  type ProductionPromptMechanicalRecovery,
  type ProductionStep,
} from '@ai-marketing/contracts';

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Called only inside the explicit retry transaction after all existing scope/source guards. */
export function beginPromptMechanicalRecovery(
  operation: string,
  status: string,
  steps: ProductionStep[],
  output: unknown,
): Record<string, unknown> | null {
  if (
    operation !== 'PROMPT' ||
    status !== 'FAILED' ||
    !record(output) ||
    output.failureReason !== 'INVALID_CANDIDATE'
  )
    return null;
  const errors = record(output.mechanicalErrors) ? output.mechanicalErrors : {};
  const sets = record(output.mechanicalIssueSets) ? output.mechanicalIssueSets : {};
  const phase = (['recheck', 'audit'] as const).find(
    (key) =>
      record(output[key + 'Corrected']) &&
      (typeof errors[key + 'Corrected'] === 'string' || Array.isArray(sets[key + 'Corrected'])) &&
      steps.some(
        (step) => step.id === (key === 'audit' ? 'REVIEW' : 'REPAIR') && step.status === 'FAILED',
      ),
  );
  if (!phase) return null;
  const previous = output.mechanicalRecovery;
  if (previous !== undefined && !isProductionPromptMechanicalRecovery(previous))
    throw new Error('机械恢复记录结构不正确，已有候选保留');
  const epoch = previous ? previous.epoch + 1 : 1;
  if (!Number.isSafeInteger(epoch)) throw new Error('机械恢复轮次超出范围，已有候选保留');
  const next = structuredClone(output);
  const corrections = record(output.corrections) ? output.corrections : {};
  const metadata: ProductionPromptMechanicalRecovery = {
    version: 1,
    epoch,
    phase,
    history: [
      ...(previous?.history ?? []),
      {
        epoch: epoch - 1,
        phase,
        candidate: output[phase] ?? null,
        correctedCandidate: output[phase + 'Corrected'],
        mechanicalError: errors[phase] ?? null,
        correctedError: errors[phase + 'Corrected'] ?? null,
        issues: sets[phase] ?? [],
        correctedIssues: sets[phase + 'Corrected'] ?? [],
        correctionCount: corrections[phase] ?? 0,
        failureReason: output.failureReason,
      },
    ],
  };
  next.mechanicalRecovery = metadata;
  next[phase] = structuredClone(output[phase + 'Corrected']);
  delete next[phase + 'Corrected'];
  delete next[phase + 'Hash'];
  delete next.failureReason;
  next.corrections = { ...corrections, [phase]: 0 };
  for (const field of ['mechanicalErrors', 'mechanicalIssueSets']) {
    const values = record(next[field]) ? { ...next[field] } : {};
    delete values[phase];
    delete values[phase + 'Corrected'];
    next[field] = values;
  }
  if (JSON.stringify(next).length > 2_000_000)
    throw new Error('候选归档超过大小限制，已有任务保留，请联系维护人员');
  return next;
}

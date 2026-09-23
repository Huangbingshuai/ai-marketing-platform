/** Public catalog entry; enabled entries have been verified against the configured account. */
export type EffectVoiceProfile = {
  id: string;
  name: string;
  gender: 'FEMALE' | 'MALE';
  description: string;
  version: string;
};
export type EffectVoiceCatalog = { profiles: EffectVoiceProfile[]; defaultId: string | null };
/** Internal frozen provider selection. Never contains credentials. */
export type EffectVoiceSelection = EffectVoiceProfile & { speaker: string; resourceId: string };
export type EffectVoicePreview = {
  id: string;
  voiceProfileId: string;
  version: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  fileObjectId: string | null;
  errorMessage: string | null;
};
export type CreateEffectVoicePreview = {
  workflowRunId: string;
  voiceProfileId: string;
  idempotencyKey: string;
};
export type EffectVoicePreviewSnapshot = { profile: EffectVoiceSelection; sampleText: string };
export type EffectVoicePreviewFailure =
  'PROVIDER_REJECTED' | 'UNAUTHORIZED' | 'SUBMISSION_UNKNOWN' | 'INVALID_AUDIO';
export type EffectVoicePreviewMessage = {
  schemaVersion: 2;
  taskType: 'VOICE_PREVIEW';
  projectId: string;
  runId: string;
  requestId: string;
};
export type SlotNarrationMetrics = {
  characters: number;
  minCharacters: number;
  targetCharacters: number;
  maxCharacters: number;
  slotSeconds: number;
  audioSeconds: number;
  utilization: number;
};

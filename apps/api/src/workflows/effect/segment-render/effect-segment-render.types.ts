import type { EffectSegmentRenderRequestSnapshot } from '@ai-marketing/contracts';

export type EffectSegmentRenderTaskCreateInput = {
  id: string;
  promptId: string;
  promptCode: string;
  renderCode: string;
  sourceFingerprint: string;
  requestSnapshot: EffectSegmentRenderRequestSnapshot;
};

export type EffectSegmentRenderStoredFile = {
  id: string;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  sha256: string;
};

export type UploadedSegmentRenderFile = {
  path: string;
  originalname: string;
  mimetype: string;
  size: number;
};

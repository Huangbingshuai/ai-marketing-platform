import type { Asset, CustomizedImportMaterial } from '@ai-marketing/contracts';

/** UI presentation only. No API/result persistence is implied by this model. */
export type CustomizedExtractionFields = {
  videoPurpose: string;
  publication: string;
  subjectName: string;
  subjectDescription: string;
  specificationAndUsage: string;
  audienceAge: string;
  audienceGender: string;
  audienceRegion: string;
  audienceProfile: string;
  coreMessage: string;
  visualStyle: string;
  mainColors: string;
  emotionalTone: string;
  duration: string;
  aspectRatio: string;
};
export type CustomizedExtractionFieldKey = keyof CustomizedExtractionFields;
export type CustomizedExtractionItem = { id: string; text: string; sourceIds: string[] };
export type CustomizedExtractionSource = {
  reference: CustomizedImportMaterial;
  asset: Asset | null;
  error?: string;
};
export type CustomizedExtractionIssue = {
  id: string;
  field: CustomizedExtractionFieldKey;
  message: string;
  sourceIds: string[];
  alternatives: string[];
  blocking: boolean;
};
export type CustomizedExtractionView = {
  status: 'EMPTY' | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'PARTIAL' | 'STALE';
  fields: CustomizedExtractionFields;
  facts: CustomizedExtractionItem[];
  avoidedElements: CustomizedExtractionItem[];
  fieldSources: Partial<Record<CustomizedExtractionFieldKey, string[]>>;
  suggestions: CustomizedExtractionFieldKey[];
  issues: CustomizedExtractionIssue[];
  editing: boolean;
  temporary: boolean;
  committed: boolean;
  saving: boolean;
  progress: number;
  progressMessage: string;
  error: string;
};
export const emptyCustomizedExtractionView = (): CustomizedExtractionView => ({
  status: 'EMPTY',
  fields: {
    videoPurpose: '',
    publication: '',
    subjectName: '',
    subjectDescription: '',
    specificationAndUsage: '',
    audienceAge: '',
    audienceGender: '',
    audienceRegion: '',
    audienceProfile: '',
    coreMessage: '',
    visualStyle: '',
    mainColors: '',
    emotionalTone: '',
    duration: '',
    aspectRatio: '',
  },
  facts: [],
  avoidedElements: [],
  fieldSources: {},
  suggestions: [],
  issues: [],
  editing: false,
  temporary: false,
  committed: false,
  saving: false,
  progress: 0,
  progressMessage: '',
  error: '',
});
export const customizedExtractionReady = (
  view: CustomizedExtractionView,
  available: boolean,
  sourceConfirmed: boolean,
): boolean =>
  available &&
  sourceConfirmed &&
  view.status === 'COMPLETED' &&
  view.committed &&
  !view.editing &&
  !view.saving &&
  !view.issues.some((issue) => issue.blocking);
export const customizedExtractionEditable = (
  view: CustomizedExtractionView,
  available: boolean,
  sourceConfirmed: boolean,
): boolean =>
  available &&
  sourceConfirmed &&
  view.editing &&
  !view.saving &&
  (view.status === 'COMPLETED' || view.status === 'STALE');

import type { Asset, CustomizedImportMaterial } from '@ai-marketing/contracts';

/** UI presentation only. No API/result persistence is implied by this model. */
export type CustomizedExtractionFields = import('@ai-marketing/contracts').CustomizedBrief;
/** A spread of a reactive card can retain a nested array proxy. Snapshot the array explicitly. */
export const snapshotCustomizedFields = (
  fields: CustomizedExtractionFields,
): CustomizedExtractionFields => ({
  ...fields,
  sellingPoints: [...fields.sellingPoints],
});
export type CustomizedExtractionFieldKey = keyof CustomizedExtractionFields;
export type CustomizedExtractionTextFieldKey = Exclude<
  CustomizedExtractionFieldKey,
  'sellingPoints'
>;
export type CustomizedExtractionSource = {
  reference: CustomizedImportMaterial;
  asset: Asset | null;
  error?: string;
};
export type CustomizedExtractionIssue = import('@ai-marketing/contracts').CustomizedBriefIssue;
export type CustomizedExtractionView = {
  status: 'EMPTY' | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'PARTIAL' | 'STALE';
  fields: CustomizedExtractionFields;
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
    brandName: '',
    projectName: '',
    projectBackground: '',
    productName: '',
    productDescription: '',
    productSpecifications: '',
    productAppearance: '',
    sellingPoints: [],
    targetAudience: '',
    brandTone: '',
    visualConsistencyRules: '',
    avoidedElements: '',
  },
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

/** Shared display contract. Business outputs remain workflow-specific. */
export type ExtractionStepStatus =
  'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'SKIPPED' | 'FAILED';
export type ExtractionGraphNode = {
  id: string;
  label: string;
  group: string;
  description?: string;
};
export type ExtractionStepExecution = {
  nodeId: string;
  status: ExtractionStepStatus;
  warnings: { code: string; message: string }[];
  errorMessage: string | null;
};
export type ExtractionDetailField = {
  key: string;
  label: string;
  value: string | number | boolean | string[] | null;
  source: string | null;
};
export type ExtractionNodeDetail = {
  nodeId: string;
  status: ExtractionStepStatus;
  summary: string;
  fields: ExtractionDetailField[];
  sources: {
    name: string;
    status: ExtractionStepStatus;
    media?: {
      kind: 'IMAGE' | 'DOCUMENT' | 'VIDEO' | 'FILE' | 'LINK';
      typeLabel: string;
      previewUrl: string | null;
      sizeBytes: number | null;
    };
    fields: ExtractionDetailField[];
    warnings: string[];
  }[];
  warnings: { code: string; message: string }[];
  errorMessage: string | null;
  updatedAt: string | null;
};

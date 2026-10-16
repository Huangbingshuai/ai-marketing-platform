export const CUSTOMIZED_IMAGE_MODELS = [
  { id: 'doubao-seedream-5-0-pro-260628', label: 'Seedream 5.0 Pro' },
  { id: 'doubao-seedream-5-0-flash-260915', label: 'Seedream 5.0 Flash' },
] as const;
export const CUSTOMIZED_IMAGE_RESOLUTIONS = ['1K', '1.5K', '2K'] as const;
export const CUSTOMIZED_IMAGE_RATIOS = [
  'auto',
  '1:1',
  '4:3',
  '3:4',
  '16:9',
  '9:16',
  '2:3',
  '3:2',
] as const;
export const CUSTOMIZED_IMAGE_MAX_BYTES = 30 * 1024 * 1024;
export const CUSTOMIZED_IMAGE_REFERENCE_MAX_BYTES = 10 * 1024 * 1024;
export const CUSTOMIZED_IMAGE_REFERENCE_LIMIT = 4;
export type CustomizedImageReference = { assetId: string; version: number };
export type CustomizedImageInput = {
  assetId: string;
  prompt: string;
  references: CustomizedImageReference[];
};
export const CUSTOMIZED_IMAGE_DIMENSIONS = {
  '1K': {
    '1:1': [1024, 1024],
    '4:3': [1152, 864],
    '3:4': [864, 1152],
    '16:9': [1424, 800],
    '9:16': [800, 1424],
    '2:3': [832, 1248],
    '3:2': [1248, 832],
  },
  '1.5K': {
    '1:1': [1536, 1536],
    '4:3': [1792, 1344],
    '3:4': [1344, 1792],
    '16:9': [2048, 1152],
    '9:16': [1152, 2048],
    '2:3': [1248, 1872],
    '3:2': [1872, 1248],
  },
  '2K': {
    '1:1': [2048, 2048],
    '4:3': [2368, 1776],
    '3:4': [1776, 2368],
    '16:9': [2816, 1584],
    '9:16': [1584, 2816],
    '2:3': [1664, 2496],
    '3:2': [2496, 1664],
  },
} as const;
export type CustomizedImageSettings = {
  model: (typeof CUSTOMIZED_IMAGE_MODELS)[number]['id'];
  resolution: (typeof CUSTOMIZED_IMAGE_RESOLUTIONS)[number];
  ratio: (typeof CUSTOMIZED_IMAGE_RATIOS)[number];
  assetIds: string[];
  /** Omitted by historical tasks and the original batch UI. */
  inputs?: CustomizedImageInput[];
};
export const CUSTOMIZED_IMAGE_SETTINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['model', 'resolution', 'ratio', 'assetIds'],
  properties: {
    model: { type: 'string', enum: CUSTOMIZED_IMAGE_MODELS.map((m) => m.id) },
    resolution: { type: 'string', enum: CUSTOMIZED_IMAGE_RESOLUTIONS },
    ratio: { type: 'string', enum: CUSTOMIZED_IMAGE_RATIOS },
    assetIds: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 200 },
    },
    inputs: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['assetId', 'prompt', 'references'],
        properties: {
          assetId: { type: 'string', minLength: 1, maxLength: 200 },
          prompt: { type: 'string', minLength: 1, maxLength: 10000 },
          references: {
            type: 'array',
            maxItems: CUSTOMIZED_IMAGE_REFERENCE_LIMIT,
            uniqueItems: true,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['assetId', 'version'],
              properties: {
                assetId: { type: 'string', format: 'uuid' },
                version: { type: 'integer', minimum: 1, maximum: 2147483647 },
              },
            },
          },
        },
      },
    },
  },
} as const;
export function isCustomizedImageSettings(value: unknown): value is CustomizedImageSettings {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).every((k) =>
      ['model', 'resolution', 'ratio', 'assetIds', 'inputs'].includes(k),
    ) &&
    CUSTOMIZED_IMAGE_MODELS.some((m) => m.id === v.model) &&
    CUSTOMIZED_IMAGE_RESOLUTIONS.some((r) => r === v.resolution) &&
    CUSTOMIZED_IMAGE_RATIOS.some((r) => r === v.ratio) &&
    Array.isArray(v.assetIds) &&
    v.assetIds.length > 0 &&
    v.assetIds.length <= 20 &&
    v.assetIds.every((id) => typeof id === 'string' && id.trim().length > 0 && id.length <= 200) &&
    new Set(v.assetIds).size === v.assetIds.length &&
    (v.inputs === undefined ||
      (Array.isArray(v.inputs) &&
        v.inputs.length === v.assetIds.length &&
        new Set(v.inputs.map((i) => i?.assetId)).size === v.inputs.length &&
        v.inputs.every(
          (i) =>
            i &&
            typeof i === 'object' &&
            !Array.isArray(i) &&
            Object.keys(i).every((k) => ['assetId', 'prompt', 'references'].includes(k)) &&
            (v.assetIds as string[]).includes(i.assetId) &&
            typeof i.prompt === 'string' &&
            i.prompt.trim().length > 0 &&
            i.prompt.length <= 10000 &&
            Array.isArray(i.references) &&
            i.references.length <= CUSTOMIZED_IMAGE_REFERENCE_LIMIT &&
            i.references.every(
              (r: CustomizedImageReference) =>
                r &&
                typeof r === 'object' &&
                Object.keys(r).every((k) => ['assetId', 'version'].includes(k)) &&
                typeof r.assetId === 'string' &&
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.assetId) &&
                Number.isSafeInteger(r.version) &&
                r.version > 0 &&
                r.version <= 2147483647,
            ) &&
            new Set(
              i.references.map(
                (r: CustomizedImageReference) => `${r.assetId.toLowerCase()}:${r.version}`,
              ),
            ).size === i.references.length,
        )))
  );
}
export const CUSTOMIZED_IMAGE_STAGES = [
  { id: 'SNAPSHOT', label: '图片制作依据', description: '确认对象形象、品牌文字约束与制作设置' },
  { id: 'GENERATE', label: '资产图片生成', description: '逐项生成并保存公共形象图片' },
  { id: 'SAVE', label: '关联资产图片', description: '关联已保存图片，保留为待确认修改' },
] as const;

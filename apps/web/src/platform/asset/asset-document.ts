import {
  EFFECT_PROMPT_DIMENSIONS,
  EFFECT_PROMPT_FRAGMENT_TYPE_LABELS,
  type EffectPromptFragmentType,
} from '@ai-marketing/contracts';
import type { BrowserAsset } from './project-asset-browser';

export type AssetDocument = {
  title: string;
  sections: { title: string; fields: { label: string; value: string }[] }[];
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(text).filter(Boolean) : [];
const field = (label: string, value: unknown) => ({ label, value: text(value) });
const purpose = (value: unknown): string =>
  EFFECT_PROMPT_FRAGMENT_TYPE_LABELS[text(value) as EffectPromptFragmentType] ?? '';

/** Business content only: never serialize worker metadata, IDs or supplier requests. */
export function assetDocument(item: BrowserAsset): AssetDocument | null {
  if (!['INSIGHT_RESULT', 'PROMPT'].includes(item.type) || item.category !== 'DOCUMENT')
    return null;
  const payload = object(
    item.source.kind === 'working' ? item.source.artifact.payload : item.source.asset.content,
  );
  if (item.type === 'INSIGHT_RESULT') {
    const fields = [
      field('产品名称', payload.productName),
      field('产品品类', payload.productCategory),
      field('核心规格', payload.coreSpecification),
      field('价格区间', payload.priceRange),
      field('外观特征', payload.visualFeatures),
    ].filter((entry) => entry.value);
    const sellingPoints = strings(payload.sellingPoints);
    return {
      title: item.name,
      sections: [
        ...(fields.length ? [{ title: '产品基础信息', fields }] : []),
        ...(sellingPoints.length
          ? [
              {
                title: `产品卖点 · ${sellingPoints.length} 条`,
                fields: sellingPoints.map((value, i) => field(`${i + 1}`, value)),
              },
            ]
          : []),
      ],
    };
  }
  const settings = object(payload.settings);
  const shared = object(payload.sharedPrompt);
  const settingsFields = [
    field(
      '默认时长',
      settings.defaultDurationSeconds ? `${settings.defaultDurationSeconds} 秒` : '',
    ),
    field('视觉风格', settings.styleMode === 'AI_AUTO' ? '由 AI 根据场景选择' : settings.styleTone),
    field('投放渠道', settings.deliveryChannel),
    field('禁用元素', strings(settings.disabledElements).join('；')),
    field('共用约束', shared.compiledContent),
  ].filter((entry) => entry.value);
  const items = Array.isArray(payload.items)
    ? payload.items
    : typeof payload.content === 'string'
      ? [payload]
      : [];
  return {
    title: item.name,
    sections: [
      ...(settingsFields.length ? [{ title: '批次设置', fields: settingsFields }] : []),
      ...items.map((raw, i) => {
        const entry = object(raw);
        const dimensions = object(entry.dimensions);
        const bindings = Array.isArray(entry.insightBindings) ? entry.insightBindings : [];
        return {
          title: `${text(entry.code) || `提示词 ${i + 1}`}${text(entry.targetDurationSeconds) ? ` · ${text(entry.targetDurationSeconds)} 秒` : ''}`,
          fields: [
            field('创意方向', entry.creativeCore),
            field('推荐用途', purpose(entry.primaryPurpose ?? entry.fragmentType)),
            field(
              '兼容用途',
              strings(entry.compatiblePurposes).map(purpose).filter(Boolean).join('、'),
            ),
            field('素材提示词', entry.content),
            ...EFFECT_PROMPT_DIMENSIONS.map(({ key, label }) => field(label, dimensions[key])),
            field(
              '来源事实',
              bindings
                .map((binding) => text(object(binding).value))
                .filter(Boolean)
                .join('\n'),
            ),
          ].filter((entry) => entry.value),
        };
      }),
    ],
  };
}

export function assetDocumentExport(item: BrowserAsset, versionLabel: string, projectName: string) {
  const document = assetDocument(item);
  if (!document || !document.sections.some((section) => section.fields.length) || item.unavailable)
    return null;
  const content = [
    document.title,
    `${projectName} · ${versionLabel}`,
    ...document.sections.map((section) =>
      [
        `【${section.title}】`,
        ...section.fields.map(({ label, value }) => `${label}：\n${value}`),
      ].join('\n\n'),
    ),
  ].join('\n\n');
  const safe = (value: string) =>
    value
      .replace(/[\\/:*?"<>|]/gu, '_')
      .split('')
      .map((character) => (character.charCodeAt(0) < 32 ? '_' : character))
      .join('')
      .replace(/[. ]+$/u, '')
      .slice(0, 100) || '资产文档';
  return {
    content: `\uFEFF${content}\n`,
    fileName: `${safe(projectName)}-${safe(document.title)}-${safe(versionLabel)}.txt`,
  };
}

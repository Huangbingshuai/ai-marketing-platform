import type { EffectPromptNodeDetailField, EffectPromptNodeId } from '@ai-marketing/contracts';

type Metadata = Record<string, unknown>;

const metadataRecord = (value: unknown): Metadata =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Metadata) : {};

const numberField = (
  metadata: Metadata,
  key: string,
  label: string,
  description?: string,
): EffectPromptNodeDetailField | null => {
  const value = metadata[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? { label, value, ...(description ? { description } : {}) }
    : null;
};

const enumField = (
  metadata: Metadata,
  key: string,
  label: string,
  allowed: readonly string[],
  description?: string,
): EffectPromptNodeDetailField | null => {
  const value = metadata[key];
  return typeof value === 'string' && allowed.includes(value)
    ? { label, value, ...(description ? { description } : {}) }
    : null;
};

const compact = (
  fields: Array<EffectPromptNodeDetailField | null>,
): EffectPromptNodeDetailField[] =>
  fields.filter((field): field is EffectPromptNodeDetailField => field !== null);

const staticField = (
  label: string,
  value: string,
  description?: string,
): EffectPromptNodeDetailField => ({ label, value, ...(description ? { description } : {}) });

export const projectEffectPromptNodeMetadata = (
  nodeId: EffectPromptNodeId,
  rawMetadata: unknown,
): EffectPromptNodeDetailField[] => {
  const metadata = metadataRecord(rawMetadata);
  switch (nodeId) {
    case 'LOAD_AND_SNAPSHOT':
      return compact([
        numberField(metadata, 'batchSize', '目标批次数量'),
        numberField(metadata, 'retainedCount', '保留的人工或非目标 Prompt'),
        numberField(metadata, 'resumedShardCount', '恢复的已完成分片'),
        staticField('快照内容', '营销洞察、批次设置与人工保留项', '不展示模型输入正文'),
      ]);
    case 'STRATEGY_PLANNING':
      return compact([
        numberField(metadata, 'narrativeCount', '叙事结构候选数'),
        numberField(metadata, 'sceneCount', '场景候选数'),
        numberField(metadata, 'personaCount', '人物候选数'),
        numberField(metadata, 'sellingPointCount', '卖点候选数'),
        numberField(metadata, 'cameraCount', '镜头语言候选数'),
        numberField(metadata, 'emotionCount', '情绪基调候选数'),
        staticField('规划示例', '家庭厨房 · 年轻家庭成员 · 产品特写', '仅展示固定业务示例'),
      ]);
    case 'DIMENSION_COMBINATION':
      return compact([
        numberField(metadata, 'plannedCandidateCount', '计划候选数'),
        numberField(metadata, 'pendingShardCount', '待生成分片'),
        numberField(metadata, 'resumedShardCount', '恢复分片'),
        numberField(metadata, 'replenishmentRound', '规划轮次'),
        numberField(metadata, 'fragmentTypeCount', '片段标签种类'),
        staticField('组合示例', '钩子片段 · 家庭场景 · 活力节奏', '仅展示固定业务示例'),
      ]);
    case 'CANDIDATE_GENERATION':
      return compact([
        numberField(metadata, 'totalShards', '分片总数'),
        numberField(metadata, 'completedShards', '已完成分片'),
        numberField(metadata, 'candidateCount', '候选 Prompt 数量'),
        staticField('候选结构', '起始画面 + 连续动作 + 产品证据 + 镜头执行 + 结束状态'),
      ]);
    case 'NORMALIZATION':
      return compact([
        numberField(metadata, 'candidateCount', '标准化 Prompt 数量'),
        numberField(metadata, 'normalizedFieldCount', '标准化字段数'),
        numberField(metadata, 'executionInvalidCount', '不可执行候选数'),
        staticField('标准结构', '单场景、单主体、单连续动作、单片段用途'),
      ]);
    case 'SEMANTIC_DEDUP':
      return compact([
        numberField(metadata, 'comparedPairCount', '校验 Prompt 对数'),
        numberField(metadata, 'violatingPairCount', '语义相似 Prompt 对数'),
        numberField(metadata, 'semanticDuplicateRate', '语义重复度（%）'),
        { label: '相似判定阈值', value: 0.82, description: '中文字符 3-gram Dice 代理指标' },
      ]);
    case 'VISUAL_DEDUP':
      return compact([
        numberField(metadata, 'comparedPairCount', '校验 Prompt 对数'),
        numberField(metadata, 'violatingPairCount', '视觉重合 Prompt 对数'),
        numberField(metadata, 'visualOverlapRate', '视觉重合度（%）'),
        {
          label: '重合判定阈值',
          value: 0.75,
          description: '基于场景、人物、镜头和情绪的生成前结构化代理指标',
        },
      ]);
    case 'QUALITY_GATE':
      return compact([
        numberField(metadata, 'acceptedCount', '通过数量'),
        numberField(metadata, 'targetCount', '目标数量'),
        numberField(metadata, 'semanticDuplicateRate', '语义重复度（%）'),
        numberField(metadata, 'visualOverlapRate', '视觉重合度（%）'),
        numberField(metadata, 'removedCount', '累计剔除数量'),
        numberField(metadata, 'executionInvalidCount', '执行门禁剔除数量'),
        numberField(metadata, 'fragmentTypesCovered', '已覆盖片段标签数'),
        numberField(metadata, 'missingSellingPointCount', '未覆盖卖点数'),
        numberField(metadata, 'replenishmentRound', '当前补齐轮次'),
        enumField(metadata, 'qualityStatus', '质量状态', ['PASS', 'NEEDS_REVIEW']),
      ]);
    case 'REPLENISH':
      return compact([
        numberField(metadata, 'replenishmentRound', '补齐轮次'),
        numberField(metadata, 'plannedCandidateCount', '补齐候选数'),
        numberField(metadata, 'pendingShardCount', '待生成分片'),
        numberField(metadata, 'resumedShardCount', '恢复分片'),
        numberField(metadata, 'missingCount', '剩余缺口'),
        numberField(metadata, 'executionInvalidCount', '执行门禁剔除数量'),
        staticField('补齐策略', '按片段标签缺口、卖点缺口和质量原因定向补齐'),
      ]);
    case 'RESULT_SAVE':
      return compact([
        numberField(metadata, 'batchSize', '已保存 Prompt 数量'),
        enumField(metadata, 'qualityStatus', '质量状态', ['PASS', 'NEEDS_REVIEW']),
        numberField(metadata, 'fragmentTypesCovered', '已覆盖片段标签数'),
      ]);
  }
};

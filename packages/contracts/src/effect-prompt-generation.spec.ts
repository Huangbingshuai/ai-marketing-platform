import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EFFECT_PROMPT_SETTINGS,
  EFFECT_PROMPT_DIMENSIONS,
  EFFECT_PROMPT_FRAGMENT_TYPES,
  EFFECT_PROMPT_GRAPH_NODE_IDS,
  EFFECT_PROMPT_INSIGHT_FIELDS,
  EFFECT_PROMPT_LIMITS,
  EFFECT_PROMPT_NODE_DETAIL_SECTION_KINDS,
  EFFECT_PROMPT_NODE_DETAIL_SECTION_STATES,
  EFFECT_PROMPT_PURPOSE_MATCH_MODES,
  EFFECT_PROMPT_REGENERATION_MODES,
  EFFECT_PROMPT_REGENERATION_REASONS,
  EFFECT_PROMPT_SEMANTIC_DUPLICATE_RATE_LIMIT,
  EFFECT_PROMPT_SEMANTIC_SIMILARITY_THRESHOLD,
  EFFECT_PROMPT_SHARD_PHASES,
  effectPromptRunGraphNodeIds,
  effectPromptSettingsNodeId,
  effectPromptTargetCount,
  readEffectPromptSettings,
  normalizeEffectPromptSettings,
  type StartEffectPromptRunRequest,
} from './effect-prompt-generation';

const batchSchema = JSON.parse(
  readFileSync(resolve(process.cwd(), 'schemas/effect-prompt-batch.schema.json'), 'utf8'),
) as Record<string, any>;

describe('effect prompt generation contract', () => {
  it('freezes the canonical settings and six coherent dimensions', () => {
    expect(DEFAULT_EFFECT_PROMPT_SETTINGS).toEqual({
      targetCount: 50,
      defaultDurationSeconds: 5,
    });
    expect(EFFECT_PROMPT_DIMENSIONS.map(({ key }) => key)).toEqual([
      'narrative',
      'scene',
      'persona',
      'productRelation',
      'camera',
      'emotion',
    ]);
    expect(effectPromptTargetCount(DEFAULT_EFFECT_PROMPT_SETTINGS)).toBe(50);
    expect(normalizeEffectPromptSettings({ targetCount: 999, defaultDurationSeconds: 1 })).toEqual({
      targetCount: 100,
      defaultDurationSeconds: 4,
    });
    expect(EFFECT_PROMPT_LIMITS.maxCount).toBe(100);
    expect(EFFECT_PROMPT_LIMITS.maxCandidateCount).toBe(240);
    expect(batchSchema.properties.settings.properties.targetCount.maximum).toBe(100);
    expect(batchSchema.properties.items.maxItems).toBe(100);
  });

  it('accepts only the canonical settings shape', () => {
    expect(
      readEffectPromptSettings({
        fragmentConfigs: {
          HOOK: { count: 10, durationSeconds: 5 },
          PAIN: { count: 8, durationSeconds: 5 },
          PRODUCT_DISPLAY: { count: 12, durationSeconds: 5 },
          SELLING_POINT_EXPLANATION: { count: 10, durationSeconds: 5 },
          CTA: { count: 6, durationSeconds: 5 },
          OUTRO: { count: 4, durationSeconds: 5 },
        },
        semanticLimit: 15,
        visualLimit: 20,
      }),
    ).toBeNull();
    expect(readEffectPromptSettings({ targetCount: 50, defaultDurationSeconds: 5 })).toEqual({
      targetCount: 50,
      defaultDurationSeconds: 5,
    });
  });

  it('publishes only the current batch and item-evaluation topology', () => {
    expect(EFFECT_PROMPT_GRAPH_NODE_IDS).toEqual([
      'LOAD_AND_SNAPSHOT',
      'INSIGHT_MAPPING',
      'FACT_VISUAL_STRATEGY_COMPILATION',
      'SHARED_PROMPT_COMPILATION',
      'COHERENT_CREATIVE_GENERATION',
      'CREATIVE_EVALUATION_CLASSIFICATION',
      'EXACT_SELECTION_AND_SUPPLEMENT',
      'RESULT_SAVE',
    ]);
    expect(effectPromptRunGraphNodeIds('ITEM_EVALUATE')).toContain('ITEM_EVALUATE');
    expect(EFFECT_PROMPT_SHARD_PHASES).toEqual(['CREATIVE', 'CLASSIFICATION']);
  });

  it('publishes additive node-detail input, output, and execution section states', () => {
    expect(EFFECT_PROMPT_NODE_DETAIL_SECTION_KINDS).toEqual(['INPUT', 'OUTPUT', 'EXECUTION']);
    expect(EFFECT_PROMPT_NODE_DETAIL_SECTION_STATES).toEqual([
      'EXPECTED',
      'ACTUAL',
      'PARTIAL',
      'EMPTY',
    ]);
  });

  it('publishes explicit primary and compatible purpose matching modes', () => {
    expect(EFFECT_PROMPT_PURPOSE_MATCH_MODES).toEqual(['PRIMARY', 'PRIMARY_OR_COMPATIBLE']);
  });

  it('keeps resolution as a structured insight constraint', () => {
    expect(EFFECT_PROMPT_INSIGHT_FIELDS).toContain('RESOLUTION');
    expect(batchSchema.$defs.insightField.enum).toContain('RESOLUTION');
  });

  it('allows item evaluation without fragment-type input', () => {
    const request: StartEffectPromptRunRequest = {
      workflowRunId: 'workflow-1',
      operation: 'ITEM_EVALUATE',
      targetItemId: 'prompt-1',
      expectedSettingsRevision: 1,
      expectedResultRevision: 2,
      idempotencyKey: 'evaluate-1',
    };
    expect(request.operation).toBe('ITEM_EVALUATE');
    expect(effectPromptSettingsNodeId('product-one')).toBe('PROMPT_GENERATION:product-one');
  });

  it('supports user-directed regeneration without requiring replacement dimensions', () => {
    const request: StartEffectPromptRunRequest = {
      workflowRunId: 'workflow-1',
      operation: 'ITEM_REGENERATE',
      targetItemId: 'prompt-1',
      regenerationMode: 'PRESERVE_PRODUCT_RELATION',
      regenerationReasons: ['TOO_SIMILAR'],
      preservedDimensions: ['productRelation'],
      expectedSettingsRevision: 1,
      expectedResultRevision: 2,
      idempotencyKey: 'regenerate-1',
    };
    expect(EFFECT_PROMPT_REGENERATION_MODES).toContain(request.regenerationMode);
    expect(EFFECT_PROMPT_REGENERATION_MODES).toContain('AUTO_DIVERSE');
    expect(EFFECT_PROMPT_REGENERATION_REASONS).toContain(request.regenerationReasons?.[0]);
    expect(request.replacementDimensions).toBeUndefined();
  });

  it('keeps the canonical JSON schema aligned with purpose and score fields', () => {
    expect(batchSchema.$id).toMatch(/effect-prompt-batch\.json$/u);
    expect(batchSchema.properties.schemaVersion).toBeUndefined();
    expect([...batchSchema.properties.settings.required].sort()).toEqual([
      'defaultDurationSeconds',
      'targetCount',
    ]);
    expect(batchSchema.$defs.dimensions.required).toContain('productRelation');
    expect(batchSchema.$defs.item.required).toEqual(
      expect.arrayContaining([
        'primaryPurpose',
        'compatiblePurposes',
        'classificationStatus',
        'productRelevance',
        'creativeCore',
      ]),
    );
    expect(batchSchema.$defs.item.required).not.toContain('materialTags');
    expect(batchSchema.$defs.item.properties.materialTags).toBeUndefined();
    expect(batchSchema.$defs.item.properties.classificationStatus.enum).toContain('NEEDS_REVISION');
    expect(batchSchema.$defs.item.properties.reviewIssues.maxItems).toBe(10);
    expect(batchSchema.$defs.item.allOf[0].then.required).toContain('reviewIssues');
    expect(batchSchema.$defs.fragmentType.enum).toEqual(EFFECT_PROMPT_FRAGMENT_TYPES);
    expect(batchSchema.properties.metrics.properties.replenishmentRounds.maximum).toBe(
      EFFECT_PROMPT_LIMITS.maxReplenishmentRounds,
    );
    expect(batchSchema.properties.metrics.required).toContain('semanticEvaluation');
    expect(EFFECT_PROMPT_SEMANTIC_SIMILARITY_THRESHOLD).toBe(0.82);
    expect(EFFECT_PROMPT_SEMANTIC_DUPLICATE_RATE_LIMIT).toBe(15);
  });
});

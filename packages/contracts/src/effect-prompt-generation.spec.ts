import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CURRENT_EFFECT_PROMPT_GRAPH_VERSION,
  DEFAULT_EFFECT_PROMPT_SETTINGS,
  EFFECT_PROMPT_DIMENSIONS,
  EFFECT_PROMPT_FRAGMENT_TYPES,
  EFFECT_PROMPT_LEGACY_SCHEMA_VERSION,
  EFFECT_PROMPT_LIMITS,
  EFFECT_PROMPT_NODE_DETAIL_SECTION_KINDS,
  EFFECT_PROMPT_NODE_DETAIL_SECTION_STATES,
  EFFECT_PROMPT_SCHEMA_VERSION,
  EFFECT_PROMPT_SHARD_PHASES,
  effectPromptGraphNodeIds,
  effectPromptRunGraphNodeIds,
  effectPromptSettingsNodeId,
  effectPromptTargetCount,
  migrateEffectPromptSettings,
  normalizeEffectPromptSettings,
  type StartEffectPromptRunRequest,
} from './effect-prompt-generation';

const batchSchema = JSON.parse(
  readFileSync(resolve(process.cwd(), 'schemas/effect-prompt-batch.schema.json'), 'utf8'),
) as Record<string, any>;

describe('effect prompt generation contract', () => {
  it('freezes the V6 settings and six coherent dimensions', () => {
    expect(EFFECT_PROMPT_SCHEMA_VERSION).toBe(6);
    expect(EFFECT_PROMPT_LEGACY_SCHEMA_VERSION).toBe(5);
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
      targetCount: 200,
      defaultDurationSeconds: 4,
    });
  });

  it('migrates historical fragment settings without carrying six quotas forward', () => {
    expect(
      migrateEffectPromptSettings({
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
    ).toEqual({ targetCount: 50, defaultDurationSeconds: 5 });
  });

  it('publishes V11 batch and item-evaluation topologies while retaining historical graphs', () => {
    expect(CURRENT_EFFECT_PROMPT_GRAPH_VERSION).toBe('V11_COHERENT_CREATIVE_GENERATION');
    expect(effectPromptGraphNodeIds('V10_RELATION_COORDINATE_BLUEPRINT')).toContain(
      'BLUEPRINT_ORTHOGONAL_GATE',
    );
    expect(
      effectPromptRunGraphNodeIds(CURRENT_EFFECT_PROMPT_GRAPH_VERSION, 'BATCH_GENERATE'),
    ).toEqual([
      'LOAD_AND_SNAPSHOT',
      'INSIGHT_MAPPING',
      'SHARED_PROMPT_COMPILATION',
      'COHERENT_CREATIVE_GENERATION',
      'CREATIVE_EVALUATION_CLASSIFICATION',
      'EXACT_SELECTION_AND_SUPPLEMENT',
      'RESULT_SAVE',
    ]);
    expect(
      effectPromptRunGraphNodeIds(CURRENT_EFFECT_PROMPT_GRAPH_VERSION, 'ITEM_EVALUATE'),
    ).toContain('ITEM_EVALUATE');
    expect(EFFECT_PROMPT_SHARD_PHASES).toEqual([
      'BLUEPRINT',
      'PROMPT',
      'CREATIVE',
      'CLASSIFICATION',
    ]);
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

  it('keeps the canonical JSON schema aligned with V6 purpose and score fields', () => {
    expect(batchSchema.$id).toMatch(/effect-prompt-batch\.v6\.json$/u);
    expect(batchSchema.properties.schemaVersion.const).toBe(6);
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
      ]),
    );
    expect(batchSchema.$defs.fragmentType.enum).toEqual(EFFECT_PROMPT_FRAGMENT_TYPES);
    expect(batchSchema.properties.metrics.properties.replenishmentRounds.maximum).toBe(
      EFFECT_PROMPT_LIMITS.maxReplenishmentRounds,
    );
  });
});

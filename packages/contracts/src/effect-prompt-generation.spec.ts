import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { StartEffectPromptRunRequest } from './effect-prompt-generation';

import {
  DEFAULT_EFFECT_PROMPT_SETTINGS,
  EFFECT_PROMPT_DIMENSIONS,
  EFFECT_PROMPT_FRAGMENT_TYPES,
  EFFECT_PROMPT_GRAPH_EDGES,
  EFFECT_PROMPT_GRAPH_NODES,
  EFFECT_PROMPT_INSIGHT_FIELDS,
  EFFECT_PROMPT_INSIGHT_FIELD_FRAGMENT_TYPES,
  EFFECT_PROMPT_LIMITS,
  EFFECT_PROMPT_NODE_DETAIL_LIMITS,
  EFFECT_PROMPT_SCHEMA_VERSION,
  effectPromptTargetCount,
  effectPromptSettingsNodeId,
  effectPromptFragmentTypeTargetCounts,
  migrateEffectPromptSettings,
  normalizeEffectPromptSettings,
} from './effect-prompt-generation';

type JsonSchemaNode = {
  $id?: string;
  $ref?: string;
  additionalProperties?: boolean;
  const?: unknown;
  enum?: string[];
  maximum?: number;
  maxItems?: number;
  minimum?: number;
  minItems?: number;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  $defs?: Record<string, JsonSchemaNode>;
};

const batchSchema = JSON.parse(
  readFileSync(resolve(process.cwd(), 'schemas/effect-prompt-batch.schema.json'), 'utf8'),
) as JsonSchemaNode;

const requireSchemaNode = (node: JsonSchemaNode | undefined, label: string): JsonSchemaNode => {
  if (!node) throw new Error(`Missing JSON Schema node: ${label}`);
  return node;
};

describe('effect prompt generation contract', () => {
  it('carries optional single-item direction and complete replacement dimensions', () => {
    const request: StartEffectPromptRunRequest = {
      workflowRunId: 'workflow-1',
      operation: 'ITEM_REGENERATE',
      targetItemId: 'prompt-1',
      regenerationInstruction: '产品更早出现',
      replacementDimensions: {
        narrative: '场景代入型',
        scene: '家庭餐桌',
        persona: '仅手部出镜',
        sellingPoint: '单手开合',
        camera: '桌面近景缓慢推进',
        emotion: '温暖舒缓',
      },
      expectedSettingsRevision: 1,
      expectedResultRevision: 2,
      idempotencyKey: 'regen-1',
    };

    expect(request.replacementDimensions?.sellingPoint).toBe('单手开合');
    expect(request.regenerationInstruction).toBe('产品更早出现');
  });

  it('freezes the six dimensions and public graph', () => {
    expect(EFFECT_PROMPT_DIMENSIONS).toHaveLength(6);
    expect(EFFECT_PROMPT_FRAGMENT_TYPES).toEqual([
      'HOOK',
      'PAIN',
      'PRODUCT_DISPLAY',
      'SELLING_POINT_EXPLANATION',
      'CTA',
      'OUTRO',
    ]);
    expect(EFFECT_PROMPT_GRAPH_NODES.map((node) => node.id)).toContain('QUALITY_GATE');
    expect(EFFECT_PROMPT_GRAPH_NODES.map((node) => node.id)).toContain('INSIGHT_MAPPING');
    expect(EFFECT_PROMPT_GRAPH_NODES.map((node) => node.id)).toContain('SHARED_PROMPT_COMPILATION');
    expect(EFFECT_PROMPT_GRAPH_NODES.map((node) => node.id)).toContain('INSIGHT_COVERAGE');
    expect(EFFECT_PROMPT_GRAPH_EDGES).toContainEqual({
      from: 'INSIGHT_MAPPING',
      to: 'SHARED_PROMPT_COMPILATION',
    });
    expect(EFFECT_PROMPT_GRAPH_EDGES).toContainEqual({
      from: 'SHARED_PROMPT_COMPILATION',
      to: 'STRATEGY_PLANNING',
    });
    expect(EFFECT_PROMPT_GRAPH_EDGES).toContainEqual({
      from: 'REPLENISH',
      to: 'FRAGMENT_TYPE_ROUTER',
    });
    expect(EFFECT_PROMPT_GRAPH_NODES.filter((node) => node.group === 'GENERATION')).toHaveLength(6);
  });

  it('freezes the V4 insight taxonomy and sensitive role boundaries', () => {
    expect(EFFECT_PROMPT_INSIGHT_FIELDS).toContain('CORE_PAIN_POINT');
    expect(EFFECT_PROMPT_INSIGHT_FIELDS).toContain('MARKETING_GOAL');
    expect(EFFECT_PROMPT_INSIGHT_FIELD_FRAGMENT_TYPES.PRICE_RANGE).toEqual(['CTA']);
    expect(EFFECT_PROMPT_INSIGHT_FIELD_FRAGMENT_TYPES.TRUST_BACKING).toEqual([
      'SELLING_POINT_EXPLANATION',
    ]);
  });

  it('normalizes six independent fragment settings', () => {
    expect(effectPromptTargetCount(DEFAULT_EFFECT_PROMPT_SETTINGS)).toBe(50);
    expect(
      normalizeEffectPromptSettings({
        fragmentConfigs: {
          ...DEFAULT_EFFECT_PROMPT_SETTINGS.fragmentConfigs,
          HOOK: { count: 0, durationSeconds: 200 },
        },
        semanticLimit: 99,
        visualLimit: 1,
      }),
    ).toEqual({
      fragmentConfigs: {
        ...DEFAULT_EFFECT_PROMPT_SETTINGS.fragmentConfigs,
        HOOK: { count: 1, durationSeconds: 15 },
      },
      semanticLimit: 15,
      visualLimit: 10,
    });
  });

  it('uses all six explicit fragment counts deterministically', () => {
    const targets = effectPromptFragmentTypeTargetCounts(DEFAULT_EFFECT_PROMPT_SETTINGS);
    expect(Object.values(targets).reduce((sum, count) => sum + count, 0)).toBe(50);
    expect(targets).toEqual({
      HOOK: 10,
      PAIN: 8,
      PRODUCT_DISPLAY: 12,
      SELLING_POINT_EXPLANATION: 10,
      CTA: 6,
      OUTRO: 4,
    });
  });

  it('migrates V2 total count and duration into six V4 fragment configs', () => {
    const migrated = migrateEffectPromptSettings(
      { count: 50, durationSeconds: 7, semanticLimit: 12, visualLimit: 18 },
      2,
    );

    expect(effectPromptFragmentTypeTargetCounts(migrated)).toEqual({
      HOOK: 10,
      PAIN: 8,
      PRODUCT_DISPLAY: 12,
      SELLING_POINT_EXPLANATION: 10,
      CTA: 6,
      OUTRO: 4,
    });
    expect(
      EFFECT_PROMPT_FRAGMENT_TYPES.map(
        (fragmentType) => migrated.fragmentConfigs[fragmentType].durationSeconds,
      ),
    ).toEqual([7, 7, 7, 7, 7, 7]);
  });

  it('preserves valid V3 fragment settings when upgrading to V4', () => {
    const v3Settings = {
      ...DEFAULT_EFFECT_PROMPT_SETTINGS,
      fragmentConfigs: {
        ...DEFAULT_EFFECT_PROMPT_SETTINGS.fragmentConfigs,
        HOOK: { count: 11, durationSeconds: 6 },
        PAIN: { count: 7, durationSeconds: 4 },
      },
    };

    expect(migrateEffectPromptSettings(v3Settings, 3)).toEqual(v3Settings);
  });

  it('does not reuse a V1 full-video duration as a fragment duration', () => {
    const migrated = migrateEffectPromptSettings(
      { count: 50, durationSeconds: 15, semanticLimit: 15, visualLimit: 20 },
      1,
    );

    expect(
      EFFECT_PROMPT_FRAGMENT_TYPES.map(
        (fragmentType) => migrated.fragmentConfigs[fragmentType].durationSeconds,
      ),
    ).toEqual([5, 5, 5, 5, 5, 5]);
  });

  it('uses a product-scoped internal node-state id', () => {
    expect(effectPromptSettingsNodeId('product-one')).toBe('PROMPT_GENERATION:product-one');
  });

  it('caps real node-detail samples without limiting the six route rows', () => {
    expect(EFFECT_PROMPT_NODE_DETAIL_LIMITS).toEqual({
      maxSamples: 3,
      maxTagValues: 8,
      maxIssues: 8,
    });
    expect(EFFECT_PROMPT_NODE_DETAIL_LIMITS.maxSamples).toBeLessThan(
      EFFECT_PROMPT_FRAGMENT_TYPES.length,
    );
  });

  it('keeps the canonical JSON schema on v5 and rejects legacy discriminators', () => {
    const schemaVersion = requireSchemaNode(
      batchSchema.properties?.schemaVersion,
      'properties.schemaVersion',
    );

    expect(batchSchema.$id).toMatch(/effect-prompt-batch\.v5\.json$/u);
    expect(schemaVersion.const).toBe(EFFECT_PROMPT_SCHEMA_VERSION);
    expect(schemaVersion.const).not.toBe(2);
    expect(batchSchema.additionalProperties).toBe(false);
  });

  it('keeps JSON settings and fragment labels aligned with the TypeScript contract', () => {
    const settings = requireSchemaNode(batchSchema.properties?.settings, 'properties.settings');
    const fragmentConfigs = requireSchemaNode(
      settings.properties?.fragmentConfigs,
      'properties.settings.properties.fragmentConfigs',
    );
    const fragmentConfig = requireSchemaNode(
      batchSchema.$defs?.fragmentConfig,
      '$defs.fragmentConfig',
    );
    const duration = requireSchemaNode(
      fragmentConfig.properties?.durationSeconds,
      '$defs.fragmentConfig.durationSeconds',
    );
    const fragmentType = requireSchemaNode(batchSchema.$defs?.fragmentType, '$defs.fragmentType');

    expect([...(settings.required ?? [])].sort()).toEqual(
      Object.keys(DEFAULT_EFFECT_PROMPT_SETTINGS).sort(),
    );
    expect(duration.minimum).toBe(EFFECT_PROMPT_LIMITS.minDurationSeconds);
    expect(duration.maximum).toBe(EFFECT_PROMPT_LIMITS.maxDurationSeconds);
    expect(fragmentType.enum).toEqual(EFFECT_PROMPT_FRAGMENT_TYPES);
    expect(fragmentConfigs.required).toEqual(EFFECT_PROMPT_FRAGMENT_TYPES);
    expect(fragmentConfigs.additionalProperties).toBe(false);
  });

  it('requires fragment-material fields and the v5 insight metrics', () => {
    const item = requireSchemaNode(batchSchema.$defs?.item, '$defs.item');
    const materialTags = requireSchemaNode(
      item.properties?.materialTags,
      '$defs.item.properties.materialTags',
    );
    const itemDuration = requireSchemaNode(
      item.properties?.targetDurationSeconds,
      '$defs.item.properties.targetDurationSeconds',
    );
    const metrics = requireSchemaNode(batchSchema.properties?.metrics, 'properties.metrics');
    const distribution = requireSchemaNode(
      batchSchema.$defs?.fragmentTypeDistribution,
      '$defs.fragmentTypeDistribution',
    );

    expect([...(item.required ?? [])].sort()).toEqual(
      [
        'id',
        'code',
        'origin',
        'fragmentType',
        'materialTags',
        'targetDurationSeconds',
        'dimensions',
        'content',
        'insightBindings',
        'manualEdited',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
    expect(item.properties?.fragmentType?.$ref).toBe('#/$defs/fragmentType');
    expect(materialTags.minItems).toBe(1);
    expect(materialTags.maxItems).toBe(EFFECT_PROMPT_LIMITS.maxMaterialTags);
    expect(itemDuration.minimum).toBe(EFFECT_PROMPT_LIMITS.minDurationSeconds);
    expect(itemDuration.maximum).toBe(EFFECT_PROMPT_LIMITS.maxDurationSeconds);
    expect([...(metrics.required ?? [])].sort()).toEqual(
      [
        'targetCount',
        'acceptedCount',
        'generatedCandidateCount',
        'fallbackCount',
        'removedSemanticDuplicates',
        'removedVisualDuplicates',
        'removedDimensionConflicts',
        'semanticDuplicateRate',
        'visualOverlapRate',
        'replenishmentRounds',
        'fragmentTypeDistribution',
        'sellingPointCoverage',
        'insightCoverage',
        'removedExecutionInvalid',
        'executionInvalidReasons',
      ].sort(),
    );
    expect(distribution.minItems).toBe(EFFECT_PROMPT_FRAGMENT_TYPES.length);
    expect(distribution.maxItems).toBe(EFFECT_PROMPT_FRAGMENT_TYPES.length);
  });
});

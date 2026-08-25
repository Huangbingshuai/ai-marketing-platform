import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EFFECT_PROMPT_SETTINGS,
  EFFECT_PROMPT_DIMENSIONS,
  EFFECT_PROMPT_FRAGMENT_TYPES,
  EFFECT_PROMPT_GRAPH_EDGES,
  EFFECT_PROMPT_GRAPH_NODES,
  EFFECT_PROMPT_LIMITS,
  EFFECT_PROMPT_SCHEMA_VERSION,
  effectPromptSettingsNodeId,
  effectPromptFragmentTypeTargetCounts,
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
  it('freezes the six dimensions and public graph', () => {
    expect(EFFECT_PROMPT_DIMENSIONS).toHaveLength(6);
    expect(EFFECT_PROMPT_FRAGMENT_TYPES).toEqual([
      'HOOK',
      'PAIN',
      'PRODUCT_DISPLAY',
      'EFFECT_DEMONSTRATION',
      'SELLING_POINT_EXPLANATION',
      'CTA',
      'OUTRO',
    ]);
    expect(EFFECT_PROMPT_GRAPH_NODES.map((node) => node.id)).toContain('QUALITY_GATE');
    expect(EFFECT_PROMPT_GRAPH_EDGES).toContainEqual({
      from: 'REPLENISH',
      to: 'CANDIDATE_GENERATION',
    });
  });

  it('normalizes prototype settings', () => {
    expect(DEFAULT_EFFECT_PROMPT_SETTINGS.count).toBe(50);
    expect(
      normalizeEffectPromptSettings({
        count: 2,
        durationSeconds: 200,
        semanticLimit: 99,
        visualLimit: 1,
        styleOverride: '  生活纪实  ',
        fragmentTypeWeights: DEFAULT_EFFECT_PROMPT_SETTINGS.fragmentTypeWeights,
        sellingPointWeights: [],
        additionalDisabledElements: ['  禁止水印  ', '禁止水印'],
      }),
    ).toEqual({
      count: 10,
      durationSeconds: 10,
      semanticLimit: 15,
      visualLimit: 10,
      styleOverride: '生活纪实',
      fragmentTypeWeights: DEFAULT_EFFECT_PROMPT_SETTINGS.fragmentTypeWeights,
      sellingPointWeights: [],
      additionalDisabledElements: ['禁止水印'],
    });
  });

  it('allocates all seven fragment labels deterministically', () => {
    const targets = effectPromptFragmentTypeTargetCounts(DEFAULT_EFFECT_PROMPT_SETTINGS);
    expect(Object.values(targets).reduce((sum, count) => sum + count, 0)).toBe(50);
    expect(Object.values(targets).every((count) => count > 0)).toBe(true);
  });

  it('uses a product-scoped internal node-state id', () => {
    expect(effectPromptSettingsNodeId('product-one')).toBe('PROMPT_GENERATION:product-one');
  });

  it('keeps the canonical JSON schema on v2 and rejects the v1 discriminator', () => {
    const schemaVersion = requireSchemaNode(
      batchSchema.properties?.schemaVersion,
      'properties.schemaVersion',
    );

    expect(batchSchema.$id).toMatch(/effect-prompt-batch\.v2\.json$/u);
    expect(schemaVersion.const).toBe(EFFECT_PROMPT_SCHEMA_VERSION);
    expect(schemaVersion.const).not.toBe(1);
    expect(batchSchema.additionalProperties).toBe(false);
  });

  it('keeps JSON settings and fragment labels aligned with the TypeScript contract', () => {
    const settings = requireSchemaNode(batchSchema.properties?.settings, 'properties.settings');
    const duration = requireSchemaNode(
      settings.properties?.durationSeconds,
      'properties.settings.properties.durationSeconds',
    );
    const fragmentTypeWeights = requireSchemaNode(
      settings.properties?.fragmentTypeWeights,
      'properties.settings.properties.fragmentTypeWeights',
    );
    const fragmentType = requireSchemaNode(batchSchema.$defs?.fragmentType, '$defs.fragmentType');

    expect([...(settings.required ?? [])].sort()).toEqual(
      Object.keys(DEFAULT_EFFECT_PROMPT_SETTINGS).sort(),
    );
    expect(duration.minimum).toBe(EFFECT_PROMPT_LIMITS.minDurationSeconds);
    expect(duration.maximum).toBe(EFFECT_PROMPT_LIMITS.maxDurationSeconds);
    expect(fragmentType.enum).toEqual(EFFECT_PROMPT_FRAGMENT_TYPES);
    expect(fragmentTypeWeights.required).toEqual(EFFECT_PROMPT_FRAGMENT_TYPES);
    expect(fragmentTypeWeights.additionalProperties).toBe(false);
  });

  it('requires fragment-material fields and the v2 quality metrics', () => {
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
        'removedSemanticDuplicates',
        'removedVisualDuplicates',
        'removedDimensionConflicts',
        'semanticDuplicateRate',
        'visualOverlapRate',
        'replenishmentRounds',
        'fragmentTypeDistribution',
        'sellingPointCoverage',
        'removedExecutionInvalid',
        'executionInvalidReasons',
      ].sort(),
    );
    expect(distribution.minItems).toBe(EFFECT_PROMPT_FRAGMENT_TYPES.length);
    expect(distribution.maxItems).toBe(EFFECT_PROMPT_FRAGMENT_TYPES.length);
  });
});

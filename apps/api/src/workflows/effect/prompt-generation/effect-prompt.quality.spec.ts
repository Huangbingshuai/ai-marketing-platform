import type { EffectPromptBatchSettings, EffectPromptItem } from '@ai-marketing/contracts';
import { DEFAULT_EFFECT_PROMPT_SETTINGS, effectPromptTargetCount } from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';

import {
  compileEffectPromptSharedConstraintPrompt,
  compileEffectPromptSharedPrompt,
  dimensionDistance,
  effectPromptExactDuplicatePairs,
  effectPromptExecutionIssues,
  effectPromptHardExecutionIssues,
  effectPromptSoftQualityWarnings,
  inferEffectPromptInsightBindings,
  mergeEffectPromptCompletionItems,
  parseEffectPromptBatchResult,
  parseLegacyV4EffectPromptBatchResultForRead,
  promptPairViolationRate,
  recomputePromptQuality,
  trigramDice,
  visualOverlap,
} from './effect-prompt.quality';

const settings: EffectPromptBatchSettings = {
  ...DEFAULT_EFFECT_PROMPT_SETTINGS,
  fragmentConfigs: Object.fromEntries(
    Object.entries(DEFAULT_EFFECT_PROMPT_SETTINGS.fragmentConfigs).map(([key, value]) => [
      key,
      { ...value },
    ]),
  ) as EffectPromptBatchSettings['fragmentConfigs'],
};

const item = (id: string, overrides: Partial<EffectPromptItem> = {}): EffectPromptItem => ({
  id,
  code: id,
  origin: 'AI',
  fragmentType: 'HOOK',
  materialTags: ['钩子', id],
  targetDurationSeconds: 5,
  dimensions: {
    narrative: `叙事-${id}`,
    scene: `场景-${id}`,
    persona: `人物-${id}`,
    sellingPoint: `卖点-${id}`,
    camera: `镜头-${id}`,
    emotion: `情绪-${id}`,
  },
  content: `家庭厨房中，一位穿围裙的成年人拿起产品并转向镜头，微距推进展示外观 ${id}`,
  insightBindings: [],
  manualEdited: false,
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:00:00.000Z',
  ...overrides,
});

describe('effect prompt quality', () => {
  it('accepts a continuous blank area as a CTA-safe composition', () => {
    const cta = item('cta-blank-area', {
      fragmentType: 'CTA',
      content:
        '广式腊肠真空袋斜放在浅木纹防油垫偏左处，右侧留着连续空白区域。一只手轻轻扶住袋身上沿，平稳挪向画面下方后收手。侧方近景固定不动，暖调自然光均匀铺开，产品清晰稳定，右侧台面干净无遮挡。',
    });

    expect(effectPromptExecutionIssues(cta)).not.toContain('CTA_NO_SAFE_AREA');
  });

  it('rejects an unexplained packaged-to-unpacked product state jump', () => {
    const productDisplay = item('product-state-jump', {
      fragmentType: 'PRODUCT_DISPLAY',
      content:
        '广式腊肠500g真空袋装首帧完整放在浅棕餐垫中央，一只手把旁侧香菌移出画面。近景平视机位缓慢横移后停止，暖柔侧光保持稳定，最终竹蒸笼上的广式腊肠整齐排列，形成稳定产品构图。',
    });

    expect(effectPromptExecutionIssues(productDisplay)).toContain('PHYSICS_BREAK');
  });

  it('accepts an outro with only observable background stabilization', () => {
    const outro = item('outro-subtle', {
      fragmentType: 'OUTRO',
      content:
        '夜间家庭厨房的木质台面上，广式腊肠稳定居中，背景蒸汽逐渐变缓，固定近景保持产品轮廓清楚，暖色侧光落在真实切面，环境亮度持续稳定，结尾形成上方留白、可持续停留的安静静物构图。',
    });

    expect(effectPromptExecutionIssues(outro)).not.toContain('NO_VISIBLE_ACTION');
  });

  it('uses Chinese character 3-gram Dice after removing fixed video parameters', () => {
    expect(
      trigramDice(
        '展示产品核心卖点。视频时长：15秒；画幅：9:16',
        '展示产品核心卖点。视频时长：30秒；画幅：16:9',
      ),
    ).toBe(1);
  });

  it('uses the frozen visual weights and dimension Hamming distance', () => {
    const left = item('left');
    const right = item('right', {
      dimensions: {
        narrative: '另一叙事',
        scene: left.dimensions.scene,
        persona: left.dimensions.persona,
        sellingPoint: '另一卖点',
        camera: left.dimensions.camera,
        emotion: '另一情绪',
      },
    });
    expect(visualOverlap(left, right)).toBeCloseTo(0.85);
    expect(dimensionDistance(left, right)).toBe(3);
  });

  it('calculates violation rate from violating pairs divided by all pairs', () => {
    const first = item('one');
    const duplicate = item('two', {
      dimensions: { ...first.dimensions },
      content: first.content,
    });
    const distinct = item('three', { content: '完全不同的户外专业测评拍摄内容' });
    const result = recomputePromptQuality([first, duplicate, distinct], settings);
    expect(result.metrics.semanticDuplicateRate).toBeCloseTo(33.33);
    expect(result.metrics.visualOverlapRate).toBeCloseTo(33.33);
    expect(result.qualityStatus).toBe('NEEDS_REVIEW');
  });

  it('separates non-blocking refinements from hard execution and safety failures', () => {
    const soft = item('soft', {
      content: '厨房里，成年人拿起产品后停稳。',
    });
    const unsafe = item('unsafe', {
      content: '厨房里，成年人拿起产品，随后凭空变形并展示工厂生产过程。',
    });

    expect(effectPromptSoftQualityWarnings(effectPromptExecutionIssues(soft))).toEqual(
      expect.arrayContaining(['PROMPT_LENGTH_MISMATCH']),
    );
    expect(effectPromptHardExecutionIssues(effectPromptExecutionIssues(soft))).toEqual([]);
    expect(effectPromptSoftQualityWarnings(['MISSING_CAMERA_EXECUTION'])).toEqual([
      'MISSING_CAMERA_EXECUTION',
    ]);
    expect(effectPromptHardExecutionIssues(['CAMERA_CONFLICT'])).toEqual(['CAMERA_CONFLICT']);
    expect(effectPromptHardExecutionIssues(effectPromptExecutionIssues(unsafe))).toEqual(
      expect.arrayContaining(['ABSTRACT_VISUAL', 'PHYSICS_BREAK']),
    );
  });

  it('passes a count-complete batch when ordinary similarity and soft warnings remain in limits', () => {
    const compactSettings: EffectPromptBatchSettings = {
      fragmentConfigs: {
        HOOK: { count: 5, durationSeconds: 5 },
        PAIN: { count: 1, durationSeconds: 5 },
        PRODUCT_DISPLAY: { count: 1, durationSeconds: 5 },
        SELLING_POINT_EXPLANATION: { count: 1, durationSeconds: 5 },
        CTA: { count: 1, durationSeconds: 5 },
        OUTRO: { count: 1, durationSeconds: 5 },
      },
      semanticLimit: 15,
      visualLimit: 20,
    };
    const fragmentTypes: EffectPromptItem['fragmentType'][] = [
      'HOOK',
      'HOOK',
      'HOOK',
      'HOOK',
      'HOOK',
      'PAIN',
      'PRODUCT_DISPLAY',
      'SELLING_POINT_EXPLANATION',
      'CTA',
      'OUTRO',
    ];
    const contents = [
      '晨光厨房里，成年人拿起杯盖靠近窗边，近景缓慢推进，停在尚未揭晓的局部。',
      '晨光厨房里，成年人拿起杯盖靠近窗边，近景缓慢推进，停在尚未揭晓的局部细节。',
      '雨后露台上，一只手扶住湿润花盆，俯视近景保持不动，水珠沿叶缘落下后停住。',
      '通勤车厢内，成年人握住松动提带尝试调整，侧面近景跟随手腕，提带仍轻轻晃动。',
      '夜间书桌前，一只手揭开收纳盒一角，微距焦点落在内部阴影，动作停在半开状态。',
      '狭窄玄关里，成年人尝试把杂乱物品放入抽屉，抽屉受阻停住，问题仍然存在。',
      '门店展示台上，产品首帧居中，一只手扶正盒身，平视近景保持轮廓清楚后停稳。',
      '午后餐桌上，成年人转动产品露出表面纹理，微距焦点保持在真实材质并停止动作。',
      '明亮台面上，一只手把产品轻放在画面左侧，固定近景保持右侧连续留白并停稳。',
      '安静背景前，产品稳定居中，蒸汽逐渐变缓，固定近景保持上方留白与静物构图。',
    ];
    const batch = fragmentTypes.map((fragmentType, index) =>
      item(`batch-${index}`, {
        fragmentType,
        content: contents[index]!,
        dimensions: {
          narrative: `叙事-${index}`,
          scene: index === 1 ? '场景-0' : `场景-${index}`,
          persona: index === 1 ? '人物-0' : `人物-${index}`,
          sellingPoint: `抽象品质-${index}`,
          camera: index === 1 ? '镜头-0' : `镜头-${index}`,
          emotion: index === 1 ? '情绪-0' : `情绪-${index}`,
        },
      }),
    );

    const result = recomputePromptQuality(batch, compactSettings);

    expect(result.items).toHaveLength(10);
    expect(result.metrics.semanticDuplicateRate).toBeGreaterThan(0);
    expect(result.metrics.semanticDuplicateRate).toBeLessThanOrEqual(compactSettings.semanticLimit);
    expect(result.metrics.visualOverlapRate).toBeLessThanOrEqual(compactSettings.visualLimit);
    expect(result.metrics.executionInvalidReasons).not.toContainEqual(
      expect.objectContaining({ code: 'PROMPT_LENGTH_MISMATCH' }),
    );
    expect(result.qualityStatus).toBe('PASS');
  });

  it('keeps completely repeated prompt text as a hard batch failure even below rate limits', () => {
    const first = item('exact-one');
    const second = item('exact-two', { content: first.content });

    expect(effectPromptExactDuplicatePairs([first, second])).toBe(1);
    expect(
      effectPromptExactDuplicatePairs([
        first,
        item('not-exact', { content: `${first.content} 补充一个真实结束状态。` }),
      ]),
    ).toBe(0);
  });

  it('rounds pair rates half-up identically to the Worker golden vector', () => {
    expect(promptPairViolationRate(63, 64)).toBe(3.13);
  });

  it('rejects incomplete six-dimensional items', () => {
    const invalid = item('invalid');
    invalid.dimensions.camera = '';
    expect(
      parseEffectPromptBatchResult({
        schemaVersion: 4,
        settings,
        items: [invalid],
        metrics: {},
        qualityStatus: 'PASS',
      }),
    ).toBeNull();
  });

  it('projects V4 audit results for read without mutating their stored payload', () => {
    const current = recomputePromptQuality([item('legacy-readable')], settings);
    const legacyMetrics = { ...current.metrics } as Record<string, unknown>;
    delete legacyMetrics.fallbackCount;
    const legacySettings = {
      ...settings,
      fragmentConfigs: Object.fromEntries(
        Object.entries(settings.fragmentConfigs).map(([key, value]) => [
          key,
          { ...value, durationSeconds: 3 },
        ]),
      ),
    };
    const legacy = {
      schemaVersion: 4,
      settings: legacySettings,
      items: [{ ...item('legacy-readable'), targetDurationSeconds: 3 }],
      metrics: legacyMetrics,
      qualityStatus: 'NEEDS_REVIEW',
    };

    const projected = parseLegacyV4EffectPromptBatchResultForRead(legacy);

    expect(projected?.schemaVersion).toBe(5);
    expect(projected?.items[0]?.targetDurationSeconds).toBe(4);
    expect(projected?.renderProfile).toEqual(
      expect.objectContaining({ ratio: '9:16', resolution: '1080p' }),
    );
    expect(legacy.items[0]?.targetDurationSeconds).toBe(3);
    expect(legacy).not.toHaveProperty('renderProfile');
  });

  it('compiles one deterministic shared constraint prompt and keeps older V5 results readable', () => {
    expect(
      compileEffectPromptSharedConstraintPrompt(['医疗暗示', ' 医疗暗示 ', '无法证明的销量背书']),
    ).toBe('画面中不得出现以下内容：医疗暗示；无法证明的销量背书。');

    const base = recomputePromptQuality([item('v5-compatible')], settings);
    const sharedPrompt = compileEffectPromptSharedPrompt([], '所有片段保持自然光质感');
    const current = recomputePromptQuality(
      base.items,
      settings,
      base.metrics,
      base.renderProfile,
      sharedPrompt,
    );
    const olderV5 = structuredClone(current) as unknown as Record<string, unknown>;
    delete olderV5.sharedPrompt;

    expect(parseEffectPromptBatchResult(olderV5)).not.toBeNull();
    expect(parseEffectPromptBatchResult(current)?.sharedPrompt).toEqual(sharedPrompt);
    expect(
      parseEffectPromptBatchResult({
        ...current,
        renderProfile: {
          ...current.renderProfile,
          sharedConstraints: {
            ...current.renderProfile.sharedConstraints,
            prompt: '模型自行补造的禁用要求',
          },
        },
      }),
    ).toBeNull();
  });

  it('enforces the shared schema text limits', () => {
    const valid = recomputePromptQuality([item('valid')], settings);
    const oversizedContent = { ...item('long'), content: '字'.repeat(12_001) };
    expect(parseEffectPromptBatchResult({ ...valid, items: [oversizedContent] })).toBeNull();

    const oversizedDimension = item('dimension');
    oversizedDimension.dimensions.sellingPoint = '卖'.repeat(241);
    expect(parseEffectPromptBatchResult({ ...valid, items: [oversizedDimension] })).toBeNull();
  });

  it('blocks legacy full-video results and flags non-executable meta timelines', () => {
    const invalid = item('legacy', {
      content:
        '痛点前置型：面向全国消费者完成单一卖点表达，前段建立情境，中段展示工艺，结尾回到产品主体。',
    });
    expect(effectPromptExecutionIssues(invalid)).toEqual(
      expect.arrayContaining([
        'META_LANGUAGE',
        'ABSTRACT_PERSONA',
        'FULL_TIMELINE_NOT_FRAGMENT',
        'NO_VISIBLE_ACTION',
      ]),
    );
    const result = recomputePromptQuality([invalid], settings);
    expect(result.metrics.executionInvalidReasons.length).toBeGreaterThan(0);
    expect(parseEffectPromptBatchResult({ ...result, schemaVersion: 1 })).toBeNull();
  });

  it('recomputes fragment-label targets and required selling-point coverage', () => {
    const result = recomputePromptQuality(
      [
        item('one', {
          fragmentType: 'PRODUCT_DISPLAY',
          insightBindings: [
            {
              factId: 'CORE_SELLING_POINT:test',
              field: 'CORE_SELLING_POINT',
              value: '卖点-one',
              valueHash: 'a'.repeat(64),
              role: 'PRIMARY',
            },
          ],
        }),
      ],
      settings,
      {
        sellingPointCoverage: {
          required: ['卖点-one', '待覆盖卖点'],
          covered: [],
          missing: [],
        },
      },
    );

    expect(
      result.metrics.fragmentTypeDistribution.reduce(
        (sum, distribution) => sum + distribution.targetCount,
        0,
      ),
    ).toBe(effectPromptTargetCount(settings));
    expect(result.metrics.sellingPointCoverage).toMatchObject({
      required: ['卖点-one', '待覆盖卖点'],
      missing: ['待覆盖卖点'],
    });
    expect(result.qualityStatus).toBe('NEEDS_REVIEW');
  });

  it('records a uniform fragment-duration mismatch in the deterministic gate', () => {
    const result = recomputePromptQuality(
      [item('duration', { targetDurationSeconds: 7 })],
      settings,
    );
    expect(result.metrics.executionInvalidReasons).toContainEqual({
      code: 'DURATION_MISMATCH',
      count: 1,
    });
    expect(result.qualityStatus).toBe('NEEDS_REVIEW');
  });

  it('recomputes V4 insight coverage and removes role-incompatible bindings', () => {
    const reference = {
      factId: 'CORE_PAIN_POINT:test',
      field: 'CORE_PAIN_POINT' as const,
      value: '年货选择困难',
      valueHash: 'b'.repeat(64),
    };
    const result = recomputePromptQuality(
      [
        item('pain', {
          fragmentType: 'PAIN',
          insightBindings: [{ ...reference, role: 'PRIMARY' }],
        }),
        item('display', {
          fragmentType: 'PRODUCT_DISPLAY',
          insightBindings: [{ ...reference, role: 'PRIMARY' }],
        }),
      ],
      settings,
      {
        insightCoverage: {
          required: [reference],
          covered: [],
          missing: [reference],
          adaptive: [],
          deferred: [],
          excluded: [],
          appliedConstraints: [],
        },
      },
    );

    expect(result.metrics.insightCoverage.covered).toEqual([reference]);
    expect(result.metrics.insightCoverage.missing).toEqual([]);
    expect(result.items.find(({ id }) => id === 'display')?.insightBindings).toEqual([]);
  });

  it('limits manually inferred expression facts to three role-prioritized bindings', () => {
    const sourceFacts: Array<[EffectPromptItem['insightBindings'][number]['field'], string]> = [
      ['PRODUCT_NAME', '便携杯'],
      ['VISUAL_FEATURES', '浅蓝圆柱杯身'],
      ['CORE_SPECIFICATION', '轻量杯身'],
      ['CORE_SELLING_POINT', '单手按键开盖'],
    ];
    const references = sourceFacts.map(([field, value], index) => ({
      factId: `${field}:${index}`,
      field,
      value,
      valueHash: String(index + 1).repeat(64),
    }));
    const prompt = item('manual-binding-limit', {
      fragmentType: 'PRODUCT_DISPLAY',
      content: '便携杯采用浅蓝圆柱杯身和轻量杯身，成年人拿起产品并呈现单手按键开盖。',
      dimensions: {
        ...item('manual-binding-limit').dimensions,
        sellingPoint: '单手按键开盖',
      },
    });

    const bindings = inferEffectPromptInsightBindings(prompt, {
      required: references,
      covered: [],
      missing: references,
      adaptive: [],
      deferred: [],
      excluded: [],
      appliedConstraints: [],
    });

    expect(bindings).toHaveLength(3);
    expect(bindings.map(({ field }) => field)).toEqual([
      'PRODUCT_NAME',
      'VISUAL_FEATURES',
      'CORE_SPECIFICATION',
    ]);
  });

  it('recognizes the natural product-display action 摆到', () => {
    const prompt = item('display', {
      fragmentType: 'PRODUCT_DISPLAY',
      content: '双手把产品摆到木质桌面中央并自然松开，镜头缓慢推近后稳定停住。',
    });

    expect(effectPromptExecutionIssues(prompt)).not.toContain('NO_VISIBLE_ACTION');
  });

  it('recognizes a visible blocked adjustment action used by pain and hook blueprints', () => {
    const prompt = item('blocked-adjustment', {
      fragmentType: 'PAIN',
      content: '成年人伸手尝试调整主体与障碍物的距离，受阻后停下，固定近景保持自然侧光。',
    });

    expect(effectPromptExecutionIssues(prompt)).not.toContain('NO_VISIBLE_ACTION');
  });

  it('caps preserved and inferred expression facts at the three-fact execution budget', () => {
    const preserved = ['PRODUCT_NAME', 'VISUAL_FEATURES', 'CORE_SPECIFICATION'] as const;
    const required = [
      ...preserved.map((field, index) => ({
        factId: `${field}:${index}`,
        field,
        value: ['便携杯', '浅蓝圆柱杯身', '轻量杯身'][index]!,
        valueHash: String(index + 1).repeat(64),
      })),
      {
        factId: 'CORE_SELLING_POINT:3',
        field: 'CORE_SELLING_POINT' as const,
        value: '单手按键开盖',
        valueHash: '4'.repeat(64),
      },
    ];
    const result = recomputePromptQuality(
      [
        item('binding-merge-budget', {
          fragmentType: 'PRODUCT_DISPLAY',
          content: '便携杯采用浅蓝圆柱杯身和轻量杯身，成年人拿起产品并呈现单手按键开盖。',
          dimensions: {
            ...item('binding-merge-budget').dimensions,
            sellingPoint: '单手按键开盖',
          },
          insightBindings: required.slice(0, 3).map((reference) => ({
            ...reference,
            role: 'CONTEXT' as const,
          })),
        }),
      ],
      settings,
      {
        insightCoverage: {
          required,
          covered: [],
          missing: required,
          adaptive: [],
          deferred: [],
          excluded: [],
          appliedConstraints: [],
        },
      },
    );

    expect(result.items[0]?.insightBindings).toHaveLength(3);
    expect(effectPromptExecutionIssues(result.items[0]!)).not.toContain('FACT_OVERLOAD');
  });

  it('does not treat render metadata in visible content as an execution failure', () => {
    const prompt = item('render-metadata', {
      content: '5秒，9:16竖屏，1080p。家庭厨房里，成年人拿起产品并转向镜头，镜头缓慢推进。',
    });

    expect(effectPromptExecutionIssues(prompt)).not.toContain('TECHNICAL_RENDER_METADATA');
    expect(effectPromptExecutionIssues(prompt)).not.toContain('SHARED_CONSTRAINT_LEAK');
  });

  it('rejects overloaded actions, conflicting cameras, baked text, audio and fact overload', () => {
    const prompt = item('quality-v4-invalid', {
      content:
        '办公室桌面前，一位成年人拿起产品。随后打开产品并倒入清水。最后放下产品并离开。固定机位环绕推近产品，字幕显示卖点，旁白配合BGM。',
      insightBindings: Array.from({ length: 4 }, (_, index) => ({
        factId: `DECISION_DRIVER:${index}`,
        field: 'DECISION_DRIVER' as const,
        value: `确认事实${index}`,
        valueHash: String(index + 1).repeat(64),
        role: 'CONTEXT' as const,
      })),
    });

    expect(effectPromptExecutionIssues(prompt)).toEqual(
      expect.arrayContaining([
        'OVERLOADED_ACTION',
        'CAMERA_CONFLICT',
        'FACT_OVERLOAD',
        'BAKED_TEXT',
        'AUDIO_OVERREACH',
      ]),
    );
  });

  it('rejects abstract proof, physical jumps, missing-reference claims and negative tails', () => {
    const prompt = item('quality-v4-risk', {
      content:
        '实验室生产线中，成年人拿起产品展示技术原理，近景固定机位保持清楚，产品随后凭空变形，包装文字与Logo完全一致。不得出现促销，不要添加认证，禁止生成价格。',
    });

    expect(effectPromptExecutionIssues(prompt)).toEqual(
      expect.arrayContaining([
        'ABSTRACT_VISUAL',
        'PHYSICS_BREAK',
        'REFERENCE_DEPENDENCY',
        'NEGATIVE_TAIL_DUPLICATION',
      ]),
    );
  });

  it('replaces only the requested item while preserving stable order and ids', () => {
    const before = [item('one'), item('target'), item('three')];
    const replacement = item('new', {
      code: 'NEW',
      fragmentType: 'CTA',
      materialTags: ['不应保留'],
      targetDurationSeconds: 9,
      content: '重新生成的全新内容',
      createdAt: '2026-08-25T01:00:00.000Z',
      updatedAt: '2026-08-25T01:00:00.000Z',
    });
    const merged = mergeEffectPromptCompletionItems([replacement], {
      schemaVersion: 5,
      projectId: 'project',
      workflowRunId: 'workflow',
      productId: 'product',
      operation: 'ITEM_REGENERATE',
      targetItemId: 'target',
      settings,
      insightArtifact: { id: 'insight', revision: 1, contentHash: 'hash', result: {} },
      retainedManualItems: [before[0]!, before[2]!],
      targetItem: before[1],
      targetItemIndex: 1,
      replacementDimensions: {
        ...before[1]!.dimensions,
        scene: '用户重新选择的家庭餐桌',
      },
      baseResultRevision: 3,
    });

    expect(merged.map(({ id }) => id)).toEqual(['one', 'target', 'three']);
    expect(merged[1]).toMatchObject({
      id: 'target',
      code: 'target',
      content: '重新生成的全新内容',
      fragmentType: before[1]!.fragmentType,
      materialTags: before[1]!.materialTags,
      targetDurationSeconds: before[1]!.targetDurationSeconds,
      dimensions: {
        ...before[1]!.dimensions,
        scene: '用户重新选择的家庭餐桌',
      },
      origin: 'AI',
      manualEdited: false,
      createdAt: before[1]!.createdAt,
    });
    expect(merged[0]).toBe(before[0]);
    expect(merged[2]).toBe(before[2]);
  });
});

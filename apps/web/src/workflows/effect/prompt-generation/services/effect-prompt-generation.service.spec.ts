import type { EffectVideoConfig } from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';

import { isPromptWorkspaceComplete } from '../effect-prompt-generation-state';
import {
  addEffectPrompt,
  deleteEffectPrompt,
  generateEffectPromptBatch,
  loadEffectPromptWorkspace,
  regenerateEffectPrompt,
  updateEffectPrompt,
  type EffectPromptContext,
} from './effect-prompt-generation.service';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  clear(): void {
    this.values.clear();
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const config: EffectVideoConfig = {
  aspectRatio: '9:16',
  durationSeconds: 15,
  resolution: '1080P',
  frameRate: 30,
  subtitleStrategy: '跟随口播',
  voiceoverStrategy: 'AI 女声',
  bgmStrategy: '自动匹配',
  styleTone: '烟火食欲感',
  deliveryChannel: '抖音',
  disabledElements: ['未成年人'],
};

const product = {
  id: 'product-1',
  name: '广式腊肠',
  category: '腊味食品',
  sku: 'SKU-001',
  effectiveConfig: config,
};
const context: EffectPromptContext = {
  projectId: 'project-1',
  workflowRunId: 'run-1',
  productId: product.id,
};

describe('effect prompt generation mock service', () => {
  it('creates and restores a complete default batch of fifty prompts', async () => {
    const storage = new MemoryStorage();
    const first = await loadEffectPromptWorkspace(context, product, config, undefined, {
      delayMs: 0,
      storage,
    });
    expect(first.items).toHaveLength(50);
    expect(first.hasGenerated).toBe(false);
    expect(first.settings.count).toBe(50);
    expect(first.metrics.removedDuplicates).toBe(8);
    expect(first.items.every((item) => item.dimensions.length >= 3)).toBe(true);
    expect(first.items.every((item) => item.semanticSimilarity <= 15)).toBe(true);
    expect(first.items.every((item) => item.visualSimilarity <= 20)).toBe(true);
    expect(isPromptWorkspaceComplete(first)).toBe(true);

    const edited = updateEffectPrompt(context, first, first.items[0]!.id, '本地恢复内容', {
      storage,
    });
    const restored = await loadEffectPromptWorkspace(context, product, config, undefined, {
      delayMs: 0,
      storage,
    });
    expect(restored.items[0]!.content).toBe('本地恢复内容');
    expect(restored.updatedAt).toBe(edited.updatedAt);
  });

  it('honors a custom count and replenishes a threshold-safe batch', async () => {
    const workspace = await generateEffectPromptBatch(
      context,
      product,
      config,
      { count: 73, durationSeconds: 20, semanticLimit: 10, visualLimit: 14 },
      undefined,
      { delayMs: 0, storage: new MemoryStorage() },
    );
    expect(workspace.items).toHaveLength(73);
    expect(workspace.hasGenerated).toBe(true);
    expect(workspace.items.every((item) => item.semanticSimilarity <= 10)).toBe(true);
    expect(workspace.items.every((item) => item.visualSimilarity <= 14)).toBe(true);
    expect(workspace.items.every((item) => item.dimensions.length === 6)).toBe(true);
  });

  it('supports add, edit, delete and single regeneration without touching another product', async () => {
    const storage = new MemoryStorage();
    const workspace = await loadEffectPromptWorkspace(context, product, config, undefined, {
      delayMs: 0,
      storage,
    });
    const added = addEffectPrompt(context, workspace, product, config, '人工添加内容', { storage });
    expect(added.items).toHaveLength(51);
    expect(added.items.at(-1)?.content).toBe('人工添加内容');

    const target = added.items[0]!;
    const regenerated = await regenerateEffectPrompt(
      context,
      added,
      target.id,
      product,
      config,
      undefined,
      { delayMs: 0, storage },
    );
    expect(regenerated.items[0]!.id).not.toBe(target.id);
    const removed = deleteEffectPrompt(context, regenerated, regenerated.items[0]!.id, {
      storage,
    });
    expect(removed.items).toHaveLength(50);

    const otherContext = { ...context, productId: 'product-2' };
    const other = await loadEffectPromptWorkspace(
      otherContext,
      { ...product, id: 'product-2', name: '另一产品' },
      config,
      undefined,
      { delayMs: 0, storage },
    );
    expect(other.items[0]!.content).not.toContain('人工添加内容');
  });

  it('cancels an in-flight mock generation through AbortSignal', async () => {
    const controller = new AbortController();
    const promise = generateEffectPromptBatch(
      context,
      product,
      config,
      { count: 50, durationSeconds: 15, semanticLimit: 15, visualLimit: 20 },
      controller.signal,
      { delayMs: 100, storage: new MemoryStorage() },
    );
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});

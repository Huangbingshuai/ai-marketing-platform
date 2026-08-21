import { describe, expect, it } from 'vitest';

import {
  cloneVideoConfig,
  createEffectImportGenerationGate,
  createIdempotencyKeyRegistry,
  createProjectWriteQueue,
  createVersionedDraftBuffer,
  drainPendingEdits,
  invalidateIdempotencyKeyOnRevisionChange,
  resolveReloadSaveState,
  resolveSuccessfulWriteSaveState,
  synchronizeCollectionItemById,
} from './effect-import-state';

describe('effect import state', () => {
  it('serializes writes inside a project without blocking another project', async () => {
    const queue = createProjectWriteQueue();
    const events: string[] = [];
    let release!: () => void;
    const first = queue.enqueue('p1', async () => {
      events.push('p1-first-start');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      events.push('p1-first-end');
    });
    const second = queue.enqueue('p1', async () => events.push('p1-second'));
    const other = queue.enqueue('p2', async () => events.push('p2'));

    await other;
    expect(events).toEqual(['p1-first-start', 'p2']);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(['p1-first-start', 'p2', 'p1-first-end', 'p1-second']);
  });

  it('invalidates stale async generations', () => {
    const gate = createEffectImportGenerationGate();
    const first = gate.begin();
    expect(gate.current(first)).toBe(true);
    const second = gate.begin();
    expect(gate.current(first)).toBe(false);
    expect(gate.current(second)).toBe(true);
    gate.invalidate();
    expect(gate.current(second)).toBe(false);
  });

  it('clones disabled elements before editing config', () => {
    const source = {
      aspectRatio: '9:16',
      durationSeconds: 15,
      resolution: '1080P',
      frameRate: 30,
      subtitleStrategy: '跟随口播',
      voiceoverStrategy: 'AI 女声',
      bgmStrategy: '自动匹配',
      styleTone: '清爽明亮',
      deliveryChannel: '抖音',
      disabledElements: ['医疗功效'],
    };
    const copy = cloneVideoConfig(source);
    copy.disabledElements.push('绝对化用语');
    expect(source.disabledElements).toEqual(['医疗功效']);
  });

  it('does not acknowledge a stale save response after a newer edit', () => {
    const buffer = createVersionedDraftBuffer<{ value: string }>();
    const sent = buffer.edit('global', { value: 'first edit' });
    buffer.edit('global', { value: 'newer edit' });

    expect(buffer.acknowledge('global', sent.version)).toBe(false);
    expect(buffer.get('global')?.value.value).toBe('newer edit');
  });

  it('retains a dirty snapshot until an explicit successful acknowledgement', () => {
    const buffer = createVersionedDraftBuffer<{ sku: string }>();
    const sent = buffer.edit('product-1', { sku: 'SKU-FAIL-RETRY' });

    expect(buffer.has('product-1')).toBe(true);
    expect(buffer.get('product-1')).toEqual(sent);
    expect(buffer.acknowledge('product-1', sent.version)).toBe(true);
    expect(buffer.has('product-1')).toBe(false);
  });

  it('does not report a normal reload as a revision conflict', () => {
    expect(resolveReloadSaveState('normal', false)).toBe('saved');
    expect(resolveReloadSaveState('normal', true)).toBe('dirty');
    expect(resolveReloadSaveState('conflict', false)).toBe('conflict');
  });

  it('can discard a deleted product without resetting other pending edits', () => {
    const buffer = createVersionedDraftBuffer<{ sku: string }>();
    buffer.edit('product-1', { sku: 'DELETE-ME' });
    buffer.edit('product-2', { sku: 'KEEP-ME' });

    buffer.discard('product-1');

    expect(buffer.has('product-1')).toBe(false);
    expect(buffer.get('product-2')?.value.sku).toBe('KEEP-ME');
  });

  it('synchronizes one canonical item across draft and filtered collections', () => {
    const draft = [{ id: 'product-1', name: 'old draft' }];
    const listed = [{ id: 'product-1', name: 'old list' }];
    const canonical = { id: 'product-1', name: 'new value' };

    const [nextDraft, nextListed] = synchronizeCollectionItemById(draft, listed, canonical);

    expect(nextDraft[0]).toBe(canonical);
    expect(nextListed[0]).toBe(canonical);
  });

  it('does not append an item that is absent from a filtered collection', () => {
    const canonical = { id: 'product-hidden', name: 'outside active filter' };

    const [nextDraft, nextListed] = synchronizeCollectionItemById([], [], canonical);

    expect(nextDraft).toEqual([canonical]);
    expect(nextListed).toEqual([]);
  });

  it('drains edits created while an older save is in flight', async () => {
    const buffer = createVersionedDraftBuffer<{ value: string }>();
    buffer.edit('global', { value: 'v1' });
    const sentValues: string[] = [];

    const saved = await drainPendingEdits(
      () => buffer.has(),
      async () => {
        const pending = buffer.get('global')!;
        sentValues.push(pending.value.value);
        if (pending.value.value === 'v1') buffer.edit('global', { value: 'v2' });
        buffer.acknowledge('global', pending.version);
        return true;
      },
    );

    expect(saved).toBe(true);
    expect(sentValues).toEqual(['v1', 'v2']);
    expect(buffer.has()).toBe(false);
  });

  it('stops draining and retains the snapshot after a failed save', async () => {
    const buffer = createVersionedDraftBuffer<{ value: string }>();
    buffer.edit('product-1', { value: 'retry me' });

    const saved = await drainPendingEdits(
      () => buffer.has(),
      async () => false,
    );

    expect(saved).toBe(false);
    expect(buffer.get('product-1')?.value.value).toBe('retry me');
  });

  it('keeps successful write state dirty while a newer edit is pending', () => {
    expect(resolveSuccessfulWriteSaveState(true)).toBe('dirty');
    expect(resolveSuccessfulWriteSaveState(false)).toBe('saved');
  });

  it('keeps a manifest commit key bound across close and reopen', () => {
    let sequence = 0;
    const registry = createIdempotencyKeyRegistry(() => `key-${++sequence}`);
    const previewRequestKey = 'preview-request-key';

    expect(registry.bind('manifest-1', previewRequestKey)).toBe(previewRequestKey);
    expect(registry.getOrCreate('manifest-1')).toBe(previewRequestKey);
    expect(registry.getOrCreate('manifest-1')).toBe(previewRequestKey);
    expect(registry.bind('manifest-1', 'new-key-after-reopen')).toBe(previewRequestKey);
  });

  it('reuses the same manifest key when the first commit response is lost', () => {
    const registry = createIdempotencyKeyRegistry(() => 'commit-retry-key');
    const firstAttemptKey = registry.getOrCreate('manifest-1');
    const responseWasLost = true;

    expect(responseWasLost).toBe(true);
    expect(registry.getOrCreate('manifest-1')).toBe(firstAttemptKey);
    registry.forget('manifest-1');
    expect(registry.get('manifest-1')).toBeNull();
  });

  it('isolates publish retry keys by project and mode and rotates after success', () => {
    let sequence = 0;
    const registry = createIdempotencyKeyRegistry(() => `publish-${++sequence}`);
    const singleContext = 'project-a:SINGLE:draft-single';
    const batchContext = 'project-a:BATCH:draft-batch';
    const firstAttempt = registry.getOrCreate(singleContext);

    expect(registry.getOrCreate(singleContext)).toBe(firstAttempt);
    expect(registry.getOrCreate(batchContext)).not.toBe(firstAttempt);
    registry.forget(singleContext);
    expect(registry.getOrCreate(singleContext)).not.toBe(firstAttempt);
  });

  it('keeps a publish retry key for an unchanged draft but drops it after revision changes', () => {
    let sequence = 0;
    const registry = createIdempotencyKeyRegistry(() => `publish-${++sequence}`);
    const context = 'project-a:SINGLE:draft-single';
    const unknownResultKey = registry.getOrCreate(context);

    invalidateIdempotencyKeyOnRevisionChange(registry, context, 5, 5);
    expect(registry.getOrCreate(context)).toBe(unknownResultKey);

    invalidateIdempotencyKeyOnRevisionChange(registry, context, 5, 6);
    expect(registry.getOrCreate(context)).not.toBe(unknownResultKey);
  });
});

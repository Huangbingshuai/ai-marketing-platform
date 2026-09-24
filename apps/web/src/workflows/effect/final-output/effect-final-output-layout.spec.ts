import { describe, expect, it } from 'vitest';

import pageSource from './EffectFinalOutputNodePage.vue?raw';

describe('effect final output re-render layout', () => {
  it('never hides the export button or the resolution and frame rate options', () => {
    // The settings row used to be replaced by a read-only summary once a batch had been exported.
    expect(pageSource).not.toContain('frozen-settings');
    expect(pageSource).not.toContain('v-if="run.status === \'PENDING_RENDER\' || active"');
    expect(pageSource).toContain('class="render-settings"');
    expect(pageSource).toContain('aria-label="成片分辨率"');
    expect(pageSource).toContain('aria-label="成片帧率"');
  });

  it('turns the second export into a re-export with a spinner icon', () => {
    expect(pageSource).toContain('重新导出成片（${run.counts.total}）');
    expect(pageSource).toContain(
      '<RefreshCw v-else-if="run.status !== \'PENDING_RENDER\'" :size="15" />',
    );
    expect(pageSource).toContain('<LoaderCircle v-if="busy || active" class="spin" :size="15" />');
    expect(pageSource).toContain('正在创建任务…');
    expect(pageSource).toContain('渲染中 ${run.counts.completed}/${run.counts.total}');
  });

  it('confirms a whole-batch re-export and keeps the settings editable between batches', () => {
    expect(pageSource).toContain('确认重新导出');
    expect(pageSource).toContain('将用当前选择的分辨率与帧率覆盖本批全部成片');
    expect(pageSource).toContain("operation: rerender ? '重新导出成片' : '开始导出成片'");
    expect(pageSource).not.toContain("if (run.value?.status !== 'PENDING_RENDER') return;");
  });

  it('re-renders a single item through its own stored spec without freezing the page', () => {
    expect(pageSource).toContain("itemRerenderingId = ref('')");
    expect(pageSource).toContain(
      "async function rerenderItem(item: FinalOutputRun['items'][number])",
    );
    expect(pageSource).toContain('`${base.value}/${run.value.id}/items/${item.id}/render`');
    expect(pageSource).toContain('确认重新渲染');
    expect(pageSource).toContain('将按这条成片已保存的分辨率与帧率重新渲染');
    expect(pageSource).toContain('class="item-rerender-button"');
    expect(pageSource).toContain(
      "{{ itemRerenderingId === item.id ? '重新渲染中…' : '重新渲染' }}",
    );
    // A single-item re-render must not grey out the whole page the way `busy` would.
    expect(pageSource).toContain(':disabled="busy || active || Boolean(itemRerenderingId)"');
    expect(pageSource).toContain('.item-rerender-button {');
  });

  it('routes both actions through the shared confirmation dialog', () => {
    expect(pageSource).toContain(
      "import { requestActionConfirmation } from '../../../shared/composables/action-confirmation';",
    );
    expect(pageSource.match(/requestActionConfirmation\(/gu)).toHaveLength(2);
  });
});

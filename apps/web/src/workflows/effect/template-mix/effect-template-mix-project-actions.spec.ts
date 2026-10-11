import { describe, expect, it } from 'vitest';
import page from './EffectTemplateMixNodePage.vue?raw';
import { packagingActionText } from './effect-packaging-progress';

const rule = (selector: string) => page.split(`${selector} {`)[1]!.split('}')[0]!;

describe('new-material partial-update action', () => {
  it('always uses amber styling and a short label without changing eligibility or behavior', () => {
    const button = [...page.matchAll(/<button\b[\s\S]*?<\/button>/gu)]
      .find(([markup]) => markup.includes('class="button source-update-button"'))![0]
      .replace(/\s+/gu, ' ')
      .replace(/="\s+/gu, '="')
      .replace(/\s+"/gu, '"');
    expect(button).toContain(
      'v-if="pendingAddedCount || (activeEntry && templatePendingUpdateCount(activeEntry)) || localUpdateBusy"',
    );
    expect(button).toContain('class="button source-update-button"');
    expect(button).toContain('<RefreshCw v-else :size="15" />局部更新');
    expect(button).toContain('<LoaderCircle v-if="localUpdateBusy" class="spin" :size="15" />');
    expect(button).not.toContain('个新增素材');
    expect(button).not.toContain('{{ pendingAddedCount }}');
    expect(button).toContain('@click="updateCurrentTemplate"');
    expect(button).toContain(':disabled="localUpdateBusy || projectEditLocked || mutating || Boolean(activeAiRun) || packagingInFlight || backgroundAiBusy"');
    expect(rule('.button.source-update-button')).toContain('color: #a66a0b;');
    expect(rule('.button.source-update-button')).toContain('background: #fffaf0;');
    expect(rule('.button.source-update-button')).toContain('border-color: #f5ca80;');
  });
});

describe('film project actions keep stable dimensions while resizing the pane', () => {
  it('scrolls fixed-width actions in one row instead of wrapping or compressing them', () => {
    const group = rule('.project-actions');
    expect(group).toContain('display: flex;');
    expect(group).toContain('flex-wrap: nowrap;');
    expect(group).toContain('overflow-x: auto;');
    expect(group).toContain('overflow-y: hidden;');
    expect(group).not.toContain('grid-template-columns');
    const button = rule('.project-actions .button');
    expect(button).toContain('flex: 0 0 136px;');
    expect(button).toContain('width: 136px;');
    expect(button).toContain('height: 32px;');
    expect(button).toContain('box-sizing: border-box;');
    expect(button).toContain('white-space: nowrap;');
    expect(button).not.toContain('width: 100%');
    expect(button).toContain('padding: 0 10px;');
    expect(button).toContain('font-size: 14px;');
    expect(rule('.project-actions .project-workflow-action')).toContain('width: 120px;');
  });
  it('uses a wand for first packaging and refresh only for repackaging, retaining the running spinner', () => {
    const markup = page.split('<div class="project-actions"')[1]!.split('</header>')[0]!;
    expect(markup).toContain('<RefreshCw v-else-if="packagingActionLabel === \'重新成片包装\'" :size="14" />');
    expect(markup).toContain('<WandSparkles v-else :size="14" />');
    expect(markup).not.toContain('<RefreshCw v-else :size="14" />');
    expect(markup).toContain('<LoaderCircle');
    expect(markup).toContain('class="spin"');
  });
  it.each([
    [false, null, '智能成片包装'],
    [true, null, '重新成片包装'],
    [false, 'COMPLETED', '重新成片包装'],
    [false, 'FAILED', '重新成片包装'],
    [false, 'PARTIAL', '重新成片包装'],
    [false, 'CANCELLED', '重新成片包装'],
  ] as const)('keeps the icon condition aligned with the label for ready=%s, status=%s', (ready, status, label) => {
    expect(packagingActionText(ready, status)).toBe(label);
  });
  it('moves new-film creation into a small accessible title action, retaining its lock rules', () => {
    expect(page).not.toContain('.project-actions .primary {');
    const markup = page.split('<div class="project-actions"')[1]!.split('</header>')[0]!;
    expect(markup).toContain('@click="openPackaging(\'ACTION\')"');
    expect(markup).toContain('@click="openPackaging(\'WORKFLOW\')"');
    expect(markup).not.toContain('@click="createEmptyVariant"');
    const title = page.split('<div class="projects-title">')[1]!.split('</div>')[0]!;
    expect(title).toContain('aria-label="新建成片"');
    expect(title).toContain('@click="createEmptyVariant"');
    expect(title).toContain('packagingSourceAutoLocked');
    expect(title).toContain('Boolean(activeAiRun)');
    expect(title).toContain('<Plus :size="15" />');
    expect(title).not.toContain('>新建成片');
    expect(rule('.project-add')).toContain('width: 28px;');
    expect(rule('.project-add')).toContain('height: 28px;');
    expect(markup).toContain('成片包装中…');
    expect(rule('.project-actions .button svg')).toContain('flex: 0 0 auto;');
  });
  it.each(['.resource-tabs', '.material-role-filters'])('keeps %s scrollable and its controls uncompressed', (selector) => {
    const group = rule(selector);
    expect(group).toContain('overflow-x: auto;');
    expect(group).toContain('overflow-y: hidden;');
    const button = rule(`${selector} button`);
    expect(button).toContain(selector === '.resource-tabs' ? 'flex: 0 0 86px;' : 'flex: 0 0 68px;');
    expect(button).toContain('white-space: nowrap;');
    expect(button).not.toContain('text-overflow: ellipsis;');
  });
  it('exposes scrollbars and keyboard focus for all three single-row control strips', () => {
    expect(page).toContain('aria-label="素材库分类" tabindex="0"');
    expect(page).toContain('aria-label="素材归槽筛选" tabindex="0"');
    expect(page).toContain('aria-label="成片项目操作" tabindex="0"');
    expect(page).toContain('scrollbar-width: thin;');
    expect(page).toContain('.project-actions::-webkit-scrollbar');
    expect(page).toContain('.resource-tabs:focus-visible');
  });
  it('lets focused control strips handle navigation without moving the timeline playhead', () => {
    const handler = page.split('const onEditorKeydown =')[1]!.split('watch(')[0]!;
    const stripGuard = handler.split('// Focused horizontal control strips')[1]!.split('// The player scrubber')[0]!;
    expect(stripGuard).toContain("target?.closest('.resource-tabs, .material-role-filters, .project-actions')");
    expect(stripGuard).toContain("['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)");
    expect(stripGuard).toContain('return;');
    expect(stripGuard).not.toContain('event.preventDefault()');
    expect(stripGuard).not.toContain('seekPreview');
  });
});

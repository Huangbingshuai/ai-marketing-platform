import { describe, expect, it } from 'vitest';

import appSource from '../app/App.vue?raw';
import assetDrawerSource from '../platform/asset/AssetDrawer.vue?raw';
import extractionSource from '../workflows/effect/information-extraction/EffectInfoExtractionNodePage.vue?raw';
import promptSource from '../workflows/effect/prompt-generation/EffectPromptGenerationNodePage.vue?raw';
import segmentSource from '../workflows/effect/segment-render/EffectSegmentRenderNodePage.vue?raw';
import importSource from '../workflows/effect/source-import/EffectImportNodePage.vue?raw';
import dialogSource from './components/ActionConfirmationDialog.vue?raw';

describe('shared destructive action confirmation', () => {
  it('mounts one accessible confirmation dialog for the whole application', () => {
    expect(appSource).toContain('<ActionConfirmationDialog />');
    expect(dialogSource).toContain('role="alertdialog"');
    expect(dialogSource).toContain('aria-modal="true"');
    expect(dialogSource).toContain('@keydown.esc="cancel"');
    expect(dialogSource).toContain('@mousedown.self="cancel"');
    expect(dialogSource).toContain('confirmButton.value?.focus()');
    expect(dialogSource).toContain('target?.isConnected');
  });

  it('replaces native and page-specific confirmations at destructive entry points', () => {
    for (const source of [
      importSource,
      extractionSource,
      promptSource,
      segmentSource,
      assetDrawerSource,
    ]) {
      expect(source).toContain('requestActionConfirmation');
      expect(source).not.toContain('window.confirm');
    }
    expect(promptSource).not.toContain('prompt-delete-dialog');
    expect(segmentSource).not.toContain('deleteDialogOpen');
  });

  it('does not stack the shared confirmation over single-Prompt regeneration', () => {
    const start = promptSource.indexOf('const openRegenerationDialog');
    const end = promptSource.indexOf('const closeRegenerationDialog', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(promptSource.slice(start, end)).not.toContain('requestActionConfirmation');
    expect(promptSource).toContain('生成 3 个备选');
  });
});

import { describe, expect, it } from 'vitest';

import pageSource from './EffectImportNodePage.vue?raw';

describe('effect import single-product prototype grid', () => {
  it('keeps upload and global configuration in the same stretched first row', () => {
    expect(pageSource).toMatch(
      /\.import-layout:not\(\.batch-mode\)[\s\S]*:deep\(\.upload-source-card\)[\s\S]*grid-column:\s*1;[\s\S]*grid-row:\s*1;/,
    );
    expect(pageSource).toMatch(
      />\s*:deep\(\.global-config-card\)[\s\S]*align-self:\s*stretch;[\s\S]*grid-column:\s*2;[\s\S]*grid-row:\s*1;/,
    );
  });

  it('places commerce parsing and imported materials across both columns below row one', () => {
    expect(pageSource).toMatch(
      /:deep\(\.commerce-parse\)[\s\S]*grid-column:\s*1\s*\/\s*-1;[\s\S]*grid-row:\s*2;/,
    );
    expect(pageSource).toMatch(
      /:deep\(\.imported-materials\)[\s\S]*grid-column:\s*1\s*\/\s*-1;[\s\S]*grid-row:\s*3;/,
    );
  });
});

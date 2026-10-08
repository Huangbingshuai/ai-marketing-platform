import { describe, expect, it } from 'vitest';
import {
  CUSTOMIZED_REQUIREMENTS_TEMPLATE_URL,
  CUSTOMIZED_REQUIREMENTS_TEMPLATE_NAME,
} from './customized-requirements-template';

describe('video production requirements template', () => {
  it('uses a Word resource and download filename', () => {
    expect(CUSTOMIZED_REQUIREMENTS_TEMPLATE_NAME).toBe('视频创作简报模板.docx');
    expect(decodeURIComponent(CUSTOMIZED_REQUIREMENTS_TEMPLATE_URL)).toContain('.docx');
  });
});

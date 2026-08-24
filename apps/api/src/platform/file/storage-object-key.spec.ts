import { buildStorageObjectKey } from './storage-object-key';
import { describe, expect, it } from 'vitest';

describe('buildStorageObjectKey', () => {
  it('builds a readable and stable product asset path', () => {
    expect(
      buildStorageObjectKey(
        {
          projectId: '443dec1d-a3b5-4035-b070-ccdd75feab5e',
          keyContext: {
            projectName: '夏季投放',
            workflow: 'EFFECT',
            lifecycle: 'assets',
            productId: 'a8c019ac-0000-4000-8000-000000000000',
            productName: '广式腊肠',
            category: '商品图片',
            originalFileName: '广式腊肠 主图.png',
          },
        },
        'f7c2fc88-2792-48b2-b006-f57eec85ac6c',
      ),
    ).toBe(
      'projects/夏季投放__443dec1d/effect/02-assets/广式腊肠__a8c019ac/商品图片/广式腊肠 主图__f7c2fc88-2792-48b2-b006-f57eec85ac6c.png',
    );
  });

  it('sanitizes unsafe path characters and supports unassigned products', () => {
    expect(
      buildStorageObjectKey(
        {
          projectId: 'project-a',
          keyContext: {
            projectName: '项目/甲',
            workflow: 'EFFECT',
            lifecycle: 'manifest',
            category: '清单:文件',
            originalFileName: '../报告?.DOCX',
          },
        },
        'object-id',
      ),
    ).toBe(
      'projects/项目_甲__project-/effect/03-manifest/未归属产品/清单_文件/报告___object-id.docx',
    );
  });

  it('keeps workflow files in the readable working directory before archival', () => {
    const key = buildStorageObjectKey(
      {
        projectId: 'project-a',
        keyContext: {
          projectName: '夏季投放',
          workflow: 'EFFECT',
          lifecycle: 'staging',
          productId: 'product-a',
          productName: '广式腊肠',
          category: '产品文档',
          originalFileName: '商品资料包.docx',
        },
      },
      'object-a',
    );

    expect(key).toContain('/effect/01-working/广式腊肠__product-/产品文档/');
    expect(key.endsWith('/商品资料包__object-a.docx')).toBe(true);
  });
});

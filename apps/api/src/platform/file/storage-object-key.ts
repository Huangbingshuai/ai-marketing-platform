import { extname } from 'node:path';

import type { StoragePutInput } from './storage.port';

const LIFECYCLE_SEGMENTS: Record<StoragePutInput['keyContext']['lifecycle'], string> = {
  staging: '01-working',
  assets: '02-assets',
  manifest: '03-manifest',
};

const cleanSegment = (value: string, fallback: string, maxLength = 80): string => {
  const cleaned = value
    .normalize('NFKC')
    .split('')
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join('')
    .replace(/[\\/:*?"<>|%]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, maxLength)
    .replace(/[.\s]+$/g, '');
  return cleaned || fallback;
};

const shortId = (value: string | undefined): string =>
  cleanSegment(value?.slice(0, 8) ?? '', 'unknown', 8);

const namedIdentity = (
  name: string | undefined,
  id: string | undefined,
  fallback: string,
): string => {
  if (!name?.trim() && !id?.trim()) return fallback;
  return `${cleanSegment(name ?? '', fallback)}__${shortId(id)}`;
};

export const buildStorageObjectKey = (
  input: Pick<StoragePutInput, 'projectId' | 'keyContext'>,
  objectId: string,
): string => {
  const { keyContext } = input;
  const originalName = keyContext.originalFileName.replace(/^.*[\\/]/, '');
  const extension = extname(originalName);
  const stem = extension ? originalName.slice(0, -extension.length) : originalName;
  const safeExtension = extension
    ? `.${cleanSegment(extension.slice(1), 'bin', 12).toLowerCase()}`
    : '';
  const fileName = `${cleanSegment(stem, '文件', 120)}__${cleanSegment(objectId, 'object', 64)}${safeExtension}`;

  return [
    'projects',
    namedIdentity(keyContext.projectName, input.projectId, '未命名项目'),
    cleanSegment(keyContext.workflow.toLowerCase(), 'unknown-workflow', 32),
    LIFECYCLE_SEGMENTS[keyContext.lifecycle],
    namedIdentity(keyContext.productName, keyContext.productId, '未归属产品'),
    cleanSegment(keyContext.category, '其他资料'),
    fileName,
  ].join('/');
};

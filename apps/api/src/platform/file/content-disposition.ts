const safeDownloadName = (fileName: string): string => {
  const basename = fileName.split(/[\\/]/).at(-1)?.trim() || 'download';
  return [...basename]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join('');
};

const asciiFallbackName = (fileName: string): string => {
  const extension = /\.[a-z0-9]{1,12}$/i.exec(fileName)?.[0].toLowerCase() ?? '';
  return `download${extension}`;
};

const encodeRfc5987 = (value: string): string =>
  encodeURIComponent(value).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export const fileContentDisposition = (
  disposition: 'inline' | 'attachment',
  fileName: string,
): string => {
  const safeName = safeDownloadName(fileName);
  return `${disposition}; filename="${asciiFallbackName(safeName)}"; filename*=UTF-8''${encodeRfc5987(safeName)}`;
};

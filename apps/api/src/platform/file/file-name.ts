export const normalizeMultipartFileName = (value: string): string => {
  // Multipart mojibake consists of single-byte Latin-1 code points. Already
  // decoded names must never be truncated back to bytes (e.g. 弧 becomes ').
  if ([...value].some((character) => (character.codePointAt(0) ?? 0) > 255)) return value;
  const encodedBytes = Buffer.from(value, 'latin1');
  const decoded = encodedBytes.toString('utf8');

  return !decoded.includes('\uFFFD') && Buffer.from(decoded, 'utf8').equals(encodedBytes)
    ? decoded
    : value;
};

export const safeOriginalFileName = (value: string): string => {
  const lastSegment = normalizeMultipartFileName(value).split(/[\\/]/).at(-1) ?? 'file';
  const sanitized = [...lastSegment]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join('')
    .trim();
  return (sanitized || 'file').normalize('NFC').slice(0, 255);
};

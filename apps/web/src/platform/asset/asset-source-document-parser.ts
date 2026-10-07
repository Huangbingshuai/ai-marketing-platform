/** Extract only text: never insert DOCX HTML or follow document links. */
export async function extractSourceDocxText(arrayBuffer: ArrayBuffer): Promise<string> {
  const { default: mammoth } = await import('mammoth/mammoth.browser');
  const result = await mammoth.extractRawText({ arrayBuffer });
  if (result.messages.some((message) => message.type === 'error'))
    throw new Error('DOCX 内容解析失败，请下载原文件检查。');
  if (result.value.length > 1_000_000) throw new Error('文档正文过大，请下载原文件查看完整内容。');
  return result.value.trim();
}

import {
  EFFECT_PROMPT_DIMENSIONS,
  EFFECT_PROMPT_FRAGMENT_TYPE_LABELS,
  type EffectPromptBatchResult,
} from '@ai-marketing/contracts';

const escapeHtml = (value: string | number): string =>
  String(value).replace(/[&<>"']/gu, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character]!;
  });

/** An offline reading document, not an executable rendering of user-authored text. */
export const buildEffectPromptHtml = (
  productName: string,
  result: EffectPromptBatchResult,
  exportedAt: string,
): string => {
  const name = escapeHtml(productName.trim() || '当前商品');
  const importedCount = result.items.filter((item) => item.origin === 'MANUAL').length;
  const directory = result.items
    .map((item, index) => `<a href="#prompt-${index + 1}">${escapeHtml(item.code)}</a>`)
    .join('');
  const cards = result.items
    .map((item, index) => {
      const compatible = item.compatiblePurposes.filter(
        (purpose) => purpose !== item.primaryPurpose,
      );
      const dimensions = EFFECT_PROMPT_DIMENSIONS.filter(({ key }) => item.dimensions[key]?.trim())
        .map(
          ({ key, label }) =>
            `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(item.dimensions[key])}</dd>`,
        )
        .join('');
      const facts = [
        ...new Set(item.insightBindings.map(({ value }) => value).filter((value) => value.trim())),
      ];
      const extra = [
        item.creativeCore?.trim()
          ? `<h3>创意主线</h3><p class="text">${escapeHtml(item.creativeCore)}</p>`
          : '',
        dimensions ? `<h3>六维信息</h3><dl>${dimensions}</dl>` : '',
        facts.length
          ? `<h3>提炼信息依据</h3><ul>${facts.map((fact) => `<li class="text">${escapeHtml(fact)}</li>`).join('')}</ul>`
          : '',
      ].join('');
      return `<article id="prompt-${index + 1}" aria-labelledby="title-${index + 1}">
<header class="card-header"><h2 id="title-${index + 1}">${escapeHtml(item.code)}</h2><div class="badges"><span>${item.origin === 'MANUAL' ? '外部导入' : 'AI 生成'}</span><span>${escapeHtml(item.targetDurationSeconds)} 秒</span><span>推荐：${escapeHtml(EFFECT_PROMPT_FRAGMENT_TYPE_LABELS[item.primaryPurpose])}</span></div></header>
${compatible.length ? `<p class="compatible">还适合：${compatible.map((purpose) => escapeHtml(EFFECT_PROMPT_FRAGMENT_TYPE_LABELS[purpose])).join('、')}</p>` : ''}
<div class="prompt text">${escapeHtml(item.content)}</div>
${extra ? `<details class="extras"><summary>创意与提炼依据</summary>${extra}</details>` : ''}
<a class="back" href="#top">返回目录 ↑</a></article>`;
    })
    .join('\n');
  const shared = result.sharedPrompt?.compiledContent ?? '';
  const date = new Date(exportedAt);
  const displayDate = Number.isNaN(date.getTime())
    ? exportedAt
    : new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'medium',
        timeStyle: 'medium',
        timeZone: 'Asia/Shanghai',
      }).format(date);
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${name} · Prompt 阅读版</title>
<style>
*{box-sizing:border-box}html{scroll-padding-top:24px}body{margin:0;background:#f5f7fb;color:#24334c;font:15px/1.8 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}main{max-width:1024px;margin:auto;padding:48px 32px}h1,h2,h3,p{margin:0}h1{font-size:30px;line-height:1.4;overflow-wrap:anywhere}h2{font-size:20px;letter-spacing:.02em}h3{font-size:14px;margin:18px 0 6px}.eyebrow{color:#2563eb;font-size:12px;letter-spacing:.12em;margin-bottom:12px}.meta,.hint{color:#63738c;font-size:13px;margin-top:12px}.hint{margin-top:6px}.directory,.shared,article{background:#fff;border:1px solid #dde5f1;border-radius:14px;margin-top:24px;padding:26px 30px}.directory summary,.extras summary{cursor:pointer;color:#3c5e8c;font-size:13px}.directory nav{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}.directory a{border:1px solid #dce6f5;border-radius:6px;padding:3px 10px;color:#315f9e;text-decoration:none;font-size:13px}a:focus-visible,summary:focus-visible{outline:2px solid #2563eb;outline-offset:3px}.card-header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;border-bottom:1px solid #edf0f6;padding-bottom:16px}.badges{display:flex;gap:8px;flex-wrap:wrap}.badges span{border-radius:5px;background:#f0f5ff;color:#365f99;font-size:12px;padding:2px 9px}.compatible{font-size:12px;color:#63738c;margin-top:12px}.text{white-space:pre-wrap;overflow-wrap:anywhere;tab-size:4}.prompt{margin-top:20px;font-size:15px;line-height:1.95}.shared h2{font-size:16px}.shared .text{font-size:14px;margin-top:12px}.extras{margin-top:24px;border-top:1px solid #edf0f6;padding-top:14px}.extras p,.extras li,.extras dd{font-size:13px;color:#52627c}dl{display:grid;grid-template-columns:90px 1fr;gap:8px 18px;margin:8px 0}dt{font-size:13px;color:#63738c}dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}ul{padding-left:20px}.back{display:inline-block;margin-top:20px;font-size:12px;color:#63738c;text-decoration:none}footer{margin-top:28px;color:#75829a;font-size:12px}
@media(max-width:600px){main{padding:24px 14px}h1{font-size:24px}.directory,.shared,article{padding:20px 18px;margin-top:16px}.prompt{font-size:14px}dl{grid-template-columns:1fr;gap:4px}dd{margin-bottom:10px}}
@media print{@page{margin:18mm}body{background:#fff;color:#111;font-size:11pt}main{max-width:none;padding:0}h1{font-size:22pt}.directory,.hint,.back{display:none}.shared,article{border:0;border-radius:0;padding:18px 0;margin-top:12px;box-shadow:none}.card-header{break-after:avoid}.prompt,.text{orphans:3;widows:3}.extras{display:block}.extras::details-content{content-visibility:visible}.extras>*{display:block!important}.extras summary{display:none!important}dl{display:grid!important}.badges span{background:none;border:1px solid #ddd}.shared h2,h3{break-after:avoid}}
</style></head><body><main id="top"><header><p class="eyebrow">素材 PROMPT · 阅读版</p><h1>${name}</h1><p class="meta">共 ${result.items.length} 条 · AI 生成 ${result.items.length - importedCount} 条 · 外部导入 ${importedCount} 条</p><p class="meta">导出时间：${escapeHtml(displayDate)}（北京时间）</p><p class="hint">点击编号跳转；使用浏览器查找定位内容，或打印 / 另存为 PDF。正文保持导出时内容，片段时长不因阅读或编辑文案改变。</p></header>
<details class="directory" open><summary>编号目录 · ${result.items.length} 条</summary><nav aria-label="Prompt 编号目录">${directory}</nav></details>
${shared.trim() ? `<section class="shared"><h2>批次共用提示词</h2><p class="text">${escapeHtml(shared)}</p></section>` : ''}
${cards}<footer>由 AI 营销素材平台导出 · 阅读版与同批 CSV 使用同一份结果快照</footer></main></body></html>`;
};

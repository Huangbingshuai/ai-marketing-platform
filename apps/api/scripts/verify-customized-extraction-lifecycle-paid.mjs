// Operates only on the isolated project created by verify-customized-extraction-paid.mjs.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
assert.equal(
  process.env.CUSTOMIZED_EXTRACTION_PAID_TEST,
  '1',
  'Explicit paid authorization required.',
);
const manifest =
  process.env.CUSTOMIZED_PAID_MANIFEST ||
  join(tmpdir(), 'customized-extraction-paid-20261010.json');
const state = JSON.parse(await readFile(manifest, 'utf8'));
const base = process.env.CUSTOMIZED_VERIFY_API_URL || 'http://localhost:3100/api';
const p = state.projectId;
const root = `/projects/${p}/workflows/customized/information-extraction`;
const checks = [];
async function request(path, method = 'GET', body, expectedStatus) {
  const response = await fetch(base + path, {
    method,
    headers: body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {},
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
  });
  const json = await response.json();
  if (expectedStatus) {
    assert.equal(response.status, expectedStatus, path);
    return json;
  }
  assert.ok(
    response.ok && json.success,
    `${method} ${path}: ${response.status} ${JSON.stringify(json.error || json.message || json)}`,
  );
  return json.data;
}
const workspace = (r = state.workflowRunId) => request(`${root}?workflowRunId=${r}`);
const persist = () => writeFile(manifest, JSON.stringify(state, null, 2));
const check = (value, name) => {
  assert.ok(value, name);
  checks.push(name);
};
const action = process.argv[2] || 'inspect';
const w = await workspace();
if (action === 'inspect') {
  check(w.task.status === 'COMPLETED', '真实任务完整成功');
  check(
    w.task.nodes.every((n) => n.status === 'SUCCEEDED'),
    '六阶段真实成功',
  );
  check(w.result.fields.productName.includes('青梅酱'), '产品名称提取');
  check(w.result.fields.sellingPoints.length > 0, '独立卖点提取');
  check(
    Object.values(w.result.fields).filter((v) => v.length).length === 12,
    '本例十二字段均有资料',
  );
  check(
    !/1080|1920|9:16|30秒|5秒/.test(w.result.fields.visualConsistencyRules),
    '视频规格和分段时长未混入视觉规则',
  );
  for (const node of w.task.nodes) {
    const detail = await request(`${root}/tasks/${w.task.id}/nodes/${node.nodeId}`);
    check(detail.status === 'SUCCEEDED', `${node.nodeId}服务端详情可读取`);
  }
  check(
    Object.values(w.result.fieldSources)
      .flat()
      .every((s) => s.assetVersion === 1 && s.location),
    '字段来源有固定版本和位置',
  );
  await request(
    root + '/results/' + w.result.id,
    'PUT',
    { expectedRevision: w.result.revision - 1, fields: w.result.fields, resolvedIssueIds: [] },
    409,
  );
  check(true, '过期编辑revision拒绝');
  await request(
    `/projects/${randomUUID()}/workflows/customized/information-extraction/tasks/${w.task.id}`,
    'GET',
    undefined,
    404,
  );
  check(true, '跨项目读取拒绝');
} else if (action === 'versions') {
  check(w.task.status === 'COMPLETED', '确认前任务完成');
  const confirmed = await request(`${root}/results/${w.result.id}/confirm`, 'POST', {
    expectedRevision: w.result.revision,
  });
  state.workflowRunId = confirmed.workflowRunId;
  check(
    (
      await request(`${root}/results/${w.result.id}/confirm`, 'POST', {
        expectedRevision: w.result.revision,
      })
    ).unchanged,
    '重复确认同内容不增版本',
  );
  const parent = state.workflowRunId;
  let child = (await request(root + '/edit', 'POST', { workflowRunId: parent })).workflowRunId;
  let draft = (await workspace(child)).result;
  const same = await request(`${root}/results/${draft.id}`, 'PUT', {
    expectedRevision: draft.revision,
    fields: draft.fields,
    resolvedIssueIds: [],
  });
  check(same.revision === draft.revision, '同内容草稿不增revision');
  const noChange = await request(`${root}/results/${draft.id}/confirm`, 'POST', {
    expectedRevision: draft.revision,
  });
  check(noChange.unchanged && noChange.workflowRunId === parent, '无修改确认不发布空分支');
  child = (await request(root + '/edit', 'POST', { workflowRunId: parent })).workflowRunId;
  draft = (await workspace(child)).result;
  state.manualBrandTone = '真实、自然，保留暖色餐桌氛围';
  const edited = await request(`${root}/results/${draft.id}`, 'PUT', {
    expectedRevision: draft.revision,
    fields: { ...draft.fields, brandTone: state.manualBrandTone },
    resolvedIssueIds: [],
  });
  check(
    (await workspace(child)).result.fields.brandTone === state.manualBrandTone,
    '人工修改刷新可恢复',
  );
  check(
    (await workspace(parent)).result.fields.brandTone === w.result.fields.brandTone,
    '编辑不污染父分支',
  );
  const saved = await request(`${root}/results/${draft.id}/confirm`, 'POST', {
    expectedRevision: edited.revision,
  });
  check(saved.workflowRunId === child && !saved.unchanged, '实际修改发布编辑分支');
  state.workflowRunId = child;
  state.source = (await workspace(child)).source;
  const cancelledChild = (await request(root + '/edit', 'POST', { workflowRunId: child }))
    .workflowRunId;
  check(
    (await request(root + '/cancel-edit', 'POST', { workflowRunId: cancelledChild }))
      .workflowRunId === child,
    '取消编辑返回原分支',
  );
  state.baselineRunId = parent;
  await persist();
} else if (action === 'same-source-reextract') {
  const child = (await request(root + '/edit', 'POST', { workflowRunId: state.workflowRunId }))
    .workflowRunId;
  state.workflowRunId = child;
  state.source = (await workspace(child)).source;
  state.previousTasks = [...(state.previousTasks || []), state.taskId];
  state.idempotencyKey = randomUUID();
  state.taskId = (
    await request(root + '/tasks', 'POST', {
      workflowRunId: child,
      sourceArtifactId: state.source.artifactId,
      sourceRevision: state.source.revision,
      idempotencyKey: state.idempotencyKey,
    })
  ).task.id;
  await persist();
  check(true, '同来源真实重提已创建');
} else if (action === 'verify-manual') {
  check(w.task.status === 'COMPLETED', '重提完整完成');
  check(w.result.fields.brandTone === state.manualBrandTone, '相同来源重提保留人工修改');
  const confirmed = await request(`${root}/results/${w.result.id}/confirm`, 'POST', {
    expectedRevision: w.result.revision,
  });
  state.workflowRunId = confirmed.workflowRunId;
  state.source = (await workspace()).source;
  await persist();
} else if (action === 'source-conflict') {
  const child = (
    await request(
      `/projects/${p}/workflow-runs/customized/branches/${state.workflowRunId}/nodes/SOURCE_IMPORT/edit`,
      'POST',
    )
  ).run.id;
  const node = `/projects/${p}/workflow-runs/${child}/nodes/SOURCE_IMPORT/state`;
  const previous = await request(node);
  async function upload(section, name, bytes, type) {
    const form = new FormData();
    form.set('section', section);
    form.set('file', new Blob([bytes], { type }), name);
    return request(
      `/projects/${p}/workflows/customized/source-import/runs/${child}/materials`,
      'POST',
      form,
    );
  }
  const supplement = await upload(
    'BRIEF',
    '青梅酱规格补充.txt',
    '本项目产品仍为梅里青梅酱，与已上传简报为同一款。产品净含量为250g/瓶。两份资料的规格不同，需要确认，不要自行选择一份。',
    'text/plain',
  );
  const logo = await upload(
    'VISUAL_REFERENCE',
    '验收占位标志.png',
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=',
      'base64',
    ),
    'image/png',
  );
  const saved = await request(node, 'PUT', {
    expectedRevision: previous.revision,
    schemaVersion: 3,
    state: {
      ...previous.state,
      materials: [
        ...previous.state.materials,
        { assetId: supplement.id, assetVersion: 1, category: 'BRIEF' },
        { assetId: logo.id, assetVersion: 1, category: 'VISUAL_REFERENCE', imageUsage: 'LOGO' },
      ],
    },
  });
  await request(
    `/projects/${p}/workflow-runs/customized/branches/${child}/source-version`,
    'POST',
    { expectedRevision: saved.nodeState.revision },
  );
  const changed = await workspace(child);
  check(changed.stale, '资料变化保留旧结果并标记待更新');
  check(changed.brandReferences.length === 1, '品牌素材固定引用存在');
  state.workflowRunId = child;
  state.source = changed.source;
  state.previousTasks = [...(state.previousTasks || []), state.taskId];
  state.idempotencyKey = randomUUID();
  state.conflictDocumentId = supplement.id;
  state.brandAssetId = logo.id;
  await persist();
  const extractionChild = (await request(root + '/edit', 'POST', { workflowRunId: child }))
    .workflowRunId;
  state.workflowRunId = extractionChild;
  state.source = (await workspace(extractionChild)).source;
  state.taskId = (
    await request(root + '/tasks', 'POST', {
      workflowRunId: extractionChild,
      sourceArtifactId: state.source.artifactId,
      sourceRevision: state.source.revision,
      idempotencyKey: state.idempotencyKey,
    })
  ).task.id;
  await persist();
  check(true, '两文档冲突真实任务已创建');
} else if (action === 'source-second-update') {
  check(w.committed && w.result.issues.length === 0, '上一轮冲突已处理并确认');
  const child = (
    await request(
      `/projects/${p}/workflow-runs/customized/branches/${state.workflowRunId}/nodes/SOURCE_IMPORT/edit`,
      'POST',
    )
  ).run.id;
  const node = `/projects/${p}/workflow-runs/${child}/nodes/SOURCE_IMPORT/state`;
  const previous = await request(node);
  const labels = {
    brandName: '品牌名称',
    projectName: '项目名称',
    projectBackground: '项目背景',
    brandTone: '品牌调性',
    visualConsistencyRules: '视觉统一规则',
    avoidedElements: '画面禁用元素',
    productName: '产品名称',
    productDescription: '产品介绍',
    productSpecifications: '产品规格',
    productAppearance: '产品外观',
    sellingPoints: '核心卖点',
    targetAudience: '目标受众',
  };
  const fields = {
    ...w.result.fields,
    brandTone: '清新真实，呈现轻松的家庭晚餐氛围',
    projectBackground: '围绕青梅酱的果肉质感与家庭餐桌搭配制作宣传短片',
  };
  const text =
    '| 填写项 | 填写内容 | 备注 / 示例 |\n| --- | --- | --- |\n' +
    Object.entries(fields)
      .map(
        ([key, value]) =>
          `| ${labels[key]} | ${Array.isArray(value) ? value.join('<br>') : value.replaceAll('\n', '<br>')} | 不应采纳的示例 |`,
      )
      .join('\n');
  const form = new FormData();
  form.set('section', 'BRIEF');
  form.set('file', new Blob([text], { type: 'text/plain' }), '青梅酱第二轮完整简报.txt');
  const doc = await request(
    `/projects/${p}/workflows/customized/source-import/runs/${child}/materials`,
    'POST',
    form,
  );
  const saved = await request(node, 'PUT', {
    expectedRevision: previous.revision,
    schemaVersion: 3,
    state: {
      ...previous.state,
      materials: [
        { assetId: doc.id, assetVersion: 1, category: 'BRIEF' },
        ...previous.state.materials.filter((m) => m.category === 'VISUAL_REFERENCE'),
      ],
    },
  });
  await request(
    `/projects/${p}/workflow-runs/customized/branches/${child}/source-version`,
    'POST',
    { expectedRevision: saved.nodeState.revision },
  );
  check((await workspace(child)).stale, '第二轮来源变化继续阻断旧结果');
  state.workflowRunId = (
    await request(root + '/edit', 'POST', { workflowRunId: child })
  ).workflowRunId;
  state.source = (await workspace()).source;
  state.idempotencyKey = randomUUID();
  state.previousTasks = [...(state.previousTasks || []), state.taskId];
  state.taskId = (
    await request(root + '/tasks', 'POST', {
      workflowRunId: state.workflowRunId,
      sourceArtifactId: state.source.artifactId,
      sourceRevision: state.source.revision,
      idempotencyKey: state.idempotencyKey,
    })
  ).task.id;
  state.secondUpdateBrandTone = fields.brandTone;
  await persist();
  check(true, '第二轮来源真实任务已创建');
} else if (action === 'verify-second-update') {
  check(w.task.status === 'COMPLETED' && !w.stale, '第二轮重新提炼结果可确认');
  check(
    w.result.fields.brandTone === state.secondUpdateBrandTone,
    '第二轮新资料未被旧人工修改覆盖',
  );
  check(w.result.fields.sellingPoints.length === 4, '第二轮保留四条独立卖点');
  check(w.result.issues.length === 0, '第二轮已更正资料无残留冲突');
  check(w.brandReferences.length === 1, '品牌引用跨两轮更新保留');
  const snapshot = await request(`${root}/tasks/${w.task.id}/nodes/LOAD_AND_SNAPSHOT`);
  check(
    snapshot.fields.find((f) => f.key === 'brandCount').value === 1,
    '工作流详情区分品牌引用用途',
  );
  state.workflowRunId = (
    await request(`${root}/results/${w.result.id}/confirm`, 'POST', {
      expectedRevision: w.result.revision,
    })
  ).workflowRunId;
  await persist();
  check((await workspace()).committed, '第二轮确认完成');
} else if (action === 'resume-source-conflict') {
  assert.ok(process.env.CUSTOMIZED_PAID_RESUME_RUN);
  const changed = await workspace(process.env.CUSTOMIZED_PAID_RESUME_RUN);
  const child = (await request(root + '/edit', 'POST', { workflowRunId: changed.workflowRunId }))
    .workflowRunId;
  state.workflowRunId = child;
  state.source = (await workspace(child)).source;
  state.idempotencyKey = randomUUID();
  state.taskId = (
    await request(root + '/tasks', 'POST', {
      workflowRunId: child,
      sourceArtifactId: state.source.artifactId,
      sourceRevision: state.source.revision,
      idempotencyKey: state.idempotencyKey,
    })
  ).task.id;
  await persist();
  check(true, '已保存的新资料版本继续真实提炼');
} else if (action === 'verify-conflict') {
  check(w.task.status === 'COMPLETED', '多文档任务完整完成');
  check(w.result.fields.brandTone !== state.manualBrandTone, '来源变化不继承旧人工覆盖');
  check(!w.stale, '新提炼结果不受旧确认产物待更新状态阻断');
  check(
    w.result.issues.some((i) => i.field === 'productSpecifications' && i.blocking),
    '规格冲突保留阻断事项',
  );
  await request(
    `${root}/results/${w.result.id}/confirm`,
    'POST',
    { expectedRevision: w.result.revision },
    400,
  );
  check(true, '未处理冲突禁止确认');
  if (process.argv.includes('--inspect-only')) {
    console.log(JSON.stringify({ action, checks }, null, 2));
    process.exit(0);
  }
  const edited = await request(`${root}/results/${w.result.id}`, 'PUT', {
    expectedRevision: w.result.revision,
    fields: {
      ...w.result.fields,
      productSpecifications: '净含量200g/瓶；未开封保质期12个月；开封后冷藏。',
    },
    resolvedIssueIds: w.result.issues.map((i) => i.id),
  });
  const confirmed = await request(`${root}/results/${w.result.id}/confirm`, 'POST', {
    expectedRevision: edited.revision,
  });
  state.workflowRunId = confirmed.workflowRunId;
  await persist();
  check((await workspace()).committed, '选择候选值并处理差异后可确认');
} else {
  throw new Error('Unknown action');
}
console.log(
  JSON.stringify(
    { action, projectId: p, workflowRunId: state.workflowRunId, taskId: state.taskId, checks },
    null,
    2,
  ),
);

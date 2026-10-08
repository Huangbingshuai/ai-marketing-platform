// Isolated real HTTP/storage verification. Never calls model/generation endpoints.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const base = process.env.CUSTOMIZED_VERIFY_API_URL || 'http://localhost:3100/api';
const projects = [];
const checks = [];
let failure;
const check = (condition, label) => {
  assert.ok(condition, label);
  checks.push(label);
};
async function request(path, method = 'GET', body, status) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {},
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
  });
  const json = await response.json();
  if (status) {
    assert.equal(response.status, status, path);
    return json;
  }
  assert.ok(
    response.ok && json.success,
    `${method} ${path}: ${response.status} ${json.error?.message || ''}`,
  );
  return json.data;
}
const nodePath = (p, r) => `/projects/${p}/workflow-runs/${r}/nodes/SOURCE_IMPORT/state`;
const branchPath = (p, r) => `/projects/${p}/workflow-runs/customized/branches/${r}`;
async function upload(p, r, section, name, bytes, mime, status) {
  const form = new FormData();
  form.set('section', section);
  form.set('file', new Blob([bytes], { type: mime }), name);
  return request(
    `/projects/${p}/workflows/customized/source-import/runs/${r}/materials`,
    'POST',
    form,
    status,
  );
}
async function saveDraft(p, r, state, revision) {
  return (
    await request(nodePath(p, r), 'PUT', { expectedRevision: revision, schemaVersion: 3, state })
  ).nodeState;
}
async function cleanupProject(p) {
  await request(`/projects/${p}`, 'DELETE', {});
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await request(`/projects/${p}/deletion`);
    if (result.status === 'COMPLETED') return;
    assert.notEqual(result.status, 'FAILED', `TEST_PROJECT_CLEANUP_FAILED:${p}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.fail(`TEST_PROJECT_CLEANUP_TIMEOUT:${p}`);
}
// Require cleanup support before creating any test data.
const cleanupProbe = await request(`/projects/${randomUUID()}/deletion`).catch(() => {
  throw new Error('验证脚本需要项目异步删除 API，请先启用清理功能；尚未创建测试数据。');
});
assert.equal(cleanupProbe.status, 'COMPLETED', '项目异步删除 API 不可用；尚未创建测试数据。');
try {
  for (let i = 0; i < 2; i++) {
    const p = await request('/projects', 'POST', {
      name: `定制资料后端验证-${randomUUID()}`,
      workflow: 'CUSTOMIZED',
      space: 'CUSTOMIZED_PROJECT',
    });
    projects.push(p.id);
  }
  const [p, other] = projects;
  const run = (await request(`/projects/${p}/workflow-runs/customized/draft`, 'POST')).run.id;
  const foreignRun = (await request(`/projects/${other}/workflow-runs/customized/draft`, 'POST'))
    .run.id;
  check(
    (await request(`/projects/${p}/workflow-runs/customized/draft`, 'POST')).run.id === run,
    '重复初始化恢复同一 Run',
  );
  await upload(p, foreignRun, 'BRIEF', 'brief.txt', 'first', 'text/plain', 409);
  check(true, '跨项目 Run 上传拒绝');
  await upload(p, run, 'BRIEF', 'fake.docx', '%PDF-1.7', 'application/octet-stream', 400);
  await upload(p, run, 'VISUAL_REFERENCE', 'brief.txt', 'first', 'text/plain', 400);
  check(true, '伪装文档和区域不匹配拒绝');
  const [a, duplicate] = await Promise.all([
    upload(p, run, 'BRIEF', 'brief.txt', 'first', 'text/plain'),
    upload(p, run, 'BRIEF', 'brief.txt', 'first', 'text/plain'),
  ]);
  check(a.id === duplicate.id && duplicate.currentVersion === 1, '并发同内容上传幂等且不增版本');
  let b = await upload(p, run, 'BRIEF', 'brief.txt', 'other', 'text/plain');
  check(a.id !== b.id, '同名同大小不同内容生成独立资产');
  const archivedId = b.id;
  await request(`/projects/${p}/assets/${b.id}/archive`, 'POST');
  b = await upload(p, run, 'BRIEF', 'brief.txt', 'other', 'text/plain');
  check(b.id !== archivedId && b.currentVersion === 1, '归档后重新上传同一文件创建新资产');
  const word = await upload(
    p,
    run,
    'BRIEF',
    '视频创作简报模板.docx',
    await readFile('docs/workflows/customized/templates/视频创作简报模板.docx'),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  );
  const image = await upload(
    p,
    run,
    'VISUAL_REFERENCE',
    'scene.png',
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=',
      'base64',
    ),
    'image/png',
  );
  check(
    word.originalFileName === '视频创作简报模板.docx' && image.previewKind === 'IMAGE',
    '真实 Word 和 PNG 上传及中文文件名',
  );
  const state = {
    schemaVersion: 3,
    requirements: '',
    materials: [
      { assetId: a.id, assetVersion: 1, category: 'BRIEF' },
      { assetId: word.id, assetVersion: 1, category: 'BRIEF' },
      { assetId: image.id, assetVersion: 1, category: 'VISUAL_REFERENCE', imageUsage: 'SCENE' },
    ],
  };
  const firstState = await saveDraft(p, run, state, null);
  check(
    (await request(nodePath(p, run))).state.materials.length === 3,
    '刷新恢复草稿全部文档及图片用途',
  );
  await request(
    `${branchPath(p, run)}/source-version`,
    'POST',
    { expectedRevision: firstState.revision + 1 },
    409,
  );
  const confirmed = await request(`${branchPath(p, run)}/source-version`, 'POST', {
    expectedRevision: firstState.revision,
  });
  check(!confirmed.createdBranch && !confirmed.unchanged, '首次保存版本提交当前 Run');
  check(
    (
      await request(`${branchPath(p, run)}/source-version`, 'POST', {
        expectedRevision: firstState.revision,
      })
    ).unchanged,
    '重复确认不增加业务 revision',
  );
  await upload(p, run, 'BRIEF', 'brief.txt', 'first', 'text/plain', 409);
  check(true, '已确认只读版本拒绝上传');
  await request(`/projects/${p}/assets/${a.id}/versions`, 'POST', {
    changeNote: '隔离验证新资产版本',
  });
  const pinned = await request(`/projects/${p}/assets/${a.id}/versions/1`);
  const content = await fetch(new URL(pinned.contentUrl, base));
  check(
    pinned.currentVersion === 1 && (await content.text()) === 'first',
    '固定文件版本读回原内容',
  );
  await request(`/projects/${other}/assets/${a.id}/versions/1`, 'GET', undefined, 404);
  const previewRead = await fetch(
    new URL(`${pinned.contentUrl}?preview=timestamp&view=timestamp`, base),
  );
  check(
    previewRead.ok && (await previewRead.text()) === 'first',
    '共用图片预览缓存参数不影响文件读取',
  );
  check(true, '跨项目读取文件版本拒绝');
  let child = (await request(`${branchPath(p, run)}/nodes/SOURCE_IMPORT/edit`, 'POST')).run.id;
  check(
    (await request(`${branchPath(p, run)}/nodes/SOURCE_IMPORT/edit`, 'POST')).run.id === child,
    '重复进入编辑恢复同一隐藏分支',
  );
  const childState = await request(nodePath(p, child));
  await saveDraft(
    p,
    child,
    { ...state, materials: [{ assetId: b.id, assetVersion: 1, category: 'BRIEF' }] },
    childState.revision,
  );
  await request(`${branchPath(p, child)}/nodes/SOURCE_IMPORT/edit/cancel`, 'POST');
  check(
    (await request(nodePath(p, run))).state.materials[0].assetId === a.id,
    '取消编辑保留父版本资料',
  );
  await upload(p, child, 'BRIEF', 'brief.txt', 'first', 'text/plain', 409);
  check(true, '取消后的旧 Run 上传拒绝');
  child = (await request(`${branchPath(p, run)}/nodes/SOURCE_IMPORT/edit`, 'POST')).run.id;
  const unchanged = await request(`${branchPath(p, child)}/source-version`, 'POST', {
    expectedRevision: (await request(nodePath(p, child))).revision,
  });
  check(unchanged.unchanged && unchanged.run.id === run, '同内容保存丢弃隐藏空分支');
  let parent = run;
  for (const usage of ['STYLE', 'OTHER']) {
    child = (await request(`${branchPath(p, parent)}/nodes/SOURCE_IMPORT/edit`, 'POST')).run.id;
    const old = await request(nodePath(p, child));
    const changed = structuredClone(old.state);
    changed.materials.find((m) => m.assetId === image.id).imageUsage = usage;
    const saved = await saveDraft(p, child, changed, old.revision);
    check(
      (
        await request(`${branchPath(p, child)}/source-version`, 'POST', {
          expectedRevision: saved.revision,
        })
      ).createdBranch,
      `图片用途 ${usage} 发布真实变更分支`,
    );
    parent = child;
  }
  const tree = await request(`/projects/${p}/workflow-runs/customized/branches`);
  check(tree.branches.length === 3, '两轮变更保留三个历史版本');
  await request(`${branchPath(p, run)}/nodes/SOURCE_IMPORT/activate`, 'POST');
  check(
    (await request(nodePath(p, run))).state.materials.find((m) => m.assetId === image.id)
      .imageUsage === 'SCENE',
    '切换历史分支恢复原图片用途',
  );
  console.log(JSON.stringify({ checks: checks.length, passed: checks }, null, 2));
} catch (error) {
  failure = error;
} finally {
  let cleaned = 0;
  for (const p of projects) {
    try {
      await cleanupProject(p);
      cleaned++;
    } catch (error) {
      console.error(`隔离测试项目清理失败：${p}`);
      failure ??= error;
    }
  }
  if (cleaned === projects.length) console.log('隔离测试项目及文件已清理');
}
if (failure) throw failure;

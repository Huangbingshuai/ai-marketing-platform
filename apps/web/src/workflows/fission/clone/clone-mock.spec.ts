import { describe, expect, it } from 'vitest';
import {
  autoMap,
  archiveCloneMock,
  candidateFor,
  cloneMockScope,
  confirmInput,
  confirmMapping,
  confirmReport,
  copy,
  createCloneMock,
  inputSignature,
  mappingSignature,
  reportSignature,
  restoreCloneMock,
  resultSignature,
  snapshotMapping,
  startResults,
  tickCloneMock,
} from './clone-mock';

describe('爆款复刻隔离 Mock 工作区', () => {
  it('演示归档重复保存同内容不增加版本，新内容只更新当前项目归档', () => {
    const state = createCloneMock('a'),
      other = createCloneMock('b');
    archiveCloneMock(state, 'input', state.confirmedInput, '标签', '说明');
    archiveCloneMock(state, 'input', state.confirmedInput, '新标签', '新说明');
    expect(state.archived.input?.version).toBe(1);
    archiveCloneMock(state, 'input', 'changed', '标签', '说明');
    expect(state.archived.input?.version).toBe(2);
    expect(other.archived).toEqual({});
  });
  it('只使用固定四节点，初始样例含报告、映射、失败和完成结果', () => {
    const state = createCloneMock('a');
    expect(state.step).toBe(0);
    expect(state.report.map((d) => d.name)).toEqual([
      '结构维度',
      '创意维度',
      '产品维度',
      '镜头维度',
      '音频维度',
      '视觉维度',
    ]);
    expect(state.shots).toHaveLength(6);
    expect(state.results.filter((r) => r.status === 'failed')).toHaveLength(1);
    expect(state.confirmedInput).toBe(inputSignature(state));
    expect(state.confirmedReport).toBe(reportSignature(state));
    expect(state.confirmedMapping).toBe(mappingSignature(state));
  });
  it('导航、重复确认与同内容恢复不改变输入快照', () => {
    const state = createCloneMock('a'),
      before = resultSignature(state);
    state.step = 3;
    confirmInput(state);
    confirmReport(state);
    confirmMapping(state);
    expect(resultSignature(state)).toBe(before);
  });
  it('项目、未绑定预览和编码后项目标识互相隔离', () => {
    const a = createCloneMock('a'),
      b = createCloneMock('b');
    a.pid = 'changed';
    const map = new Map([
      [a.scope, JSON.stringify(a)],
      [b.scope, JSON.stringify(b)],
    ]);
    const storage = { getItem: (key: string) => map.get(key) ?? null };
    expect(restoreCloneMock(storage, 'a').pid).toBe('changed');
    expect(restoreCloneMock(storage, 'b').pid).not.toBe('changed');
    expect(new Set(['a', 'b', '', 'a.b', 'a/b'].map(cloneMockScope)).size).toBe(5);
  });
  it('损坏或错误作用域的草稿明确失败，不自动覆盖', () => {
    expect(() => restoreCloneMock({ getItem: () => '{oops' }, 'a')).toThrow();
    expect(() =>
      restoreCloneMock({ getItem: () => JSON.stringify(createCloneMock('b')) }, 'a'),
    ).toThrow();
  });
  it('空态不伪造报告或允许没有必换产品的生成', () => {
    const state = createCloneMock('a', true);
    expect(state.reference).toBeNull();
    expect(state.results).toHaveLength(0);
    expect(state.reportReady).toBe(false);
    expect(() => confirmInput(state)).toThrow('参考视频');
    expect(() => startResults(state, 1, 1000)).toThrow();
  });
  it('必换产品必须选择同类型的现存素材，删除素材会阻止确认', () => {
    const state = createCloneMock('a');
    state.elements[0]!.targetId = 'PERSON-CHEF';
    expect(candidateFor(state, state.elements[0]!)).toBeUndefined();
    expect(() => confirmMapping(state)).toThrow('必换产品');
    state.elements[0]!.targetId = state.materials[0]!.id;
    state.materials = [];
    expect(() => confirmMapping(state)).toThrow();
  });
  it('两轮上游变化均使实际引用的旧结果待更新，其他项目保持原样', () => {
    const state = createCloneMock('a'),
      other = createCloneMock('b'),
      otherSignature = resultSignature(other);
    for (let i = 0; i < 2; i++) {
      const old = state.results[0]!.snapshot;
      state.materials[0]!.name = `新包装${i}.png`;
      confirmInput(state);
      expect(() => confirmReport(state)).toThrow();
      state.job = { kind: 'analysis', startedAt: i * 10000, snapshot: state.confirmedInput };
      tickCloneMock(state, i * 10000 + 2300);
      expect(state.mappingReport).not.toBe(state.confirmedReport);
      expect(() => confirmMapping(state)).toThrow('重新匹配');
      autoMap(state);
      confirmMapping(state);
      expect(resultSignature(state)).not.toBe(old);
    }
    expect(resultSignature(other)).toBe(otherSignature);
  });
  it('人工报告和镜头编辑先留草稿，确认后才影响已引用的下游', () => {
    const state = createCloneMock('a'),
      before = resultSignature(state);
    state.shots[0]!.move = '缓慢推进';
    state.report[0]!.hook = '新的钩子';
    expect(resultSignature(state)).toBe(before);
    expect(() => confirmMapping(state)).toThrow();
    confirmReport(state);
    expect(resultSignature(state)).not.toBe(before);
  });
  it('旧拆解任务迟到不能覆盖已确认的新输入', () => {
    const state = createCloneMock('a'),
      report = state.confirmedReport;
    state.job = { kind: 'analysis', startedAt: 1000, snapshot: state.confirmedInput };
    state.reference!.name = '新参考.mp4';
    confirmInput(state);
    tickCloneMock(state, 5000);
    expect(state.confirmedReport).toBe(report);
    expect(state.job).toBeNull();
    expect(state.reportInput).not.toBe(state.confirmedInput);
  });
  it('生成任务冻结映射名称和快照，后续编辑不改历史输入', () => {
    const state = createCloneMock('a');
    state.results = [];
    startResults(state, 2, 1000);
    const snapshot = copy(state.results[0]!.mapping),
      source = state.results[0]!.snapshot;
    state.elements[0]!.targetId = state.materials[0]!.id;
    confirmMapping(state);
    state.materials[1]!.name = '后续改名.png';
    expect(state.results[0]!.mapping).toEqual(snapshot);
    expect(state.results[0]!.snapshot).toBe(source);
    expect(snapshotMapping(state)).not.toEqual(snapshot);
  });
  it('刷新恢复运行中任务并完成，不重复创建任务；模拟失败保留失败终态', () => {
    const state = createCloneMock('a');
    state.results = [];
    startResults(state, 3, 1000, true);
    const restored = restoreCloneMock({ getItem: () => JSON.stringify(state) }, 'a');
    tickCloneMock(restored, 3500);
    expect(restored.results.every((r) => r.progress > 0 && r.progress < 100)).toBe(true);
    tickCloneMock(restored, 7000);
    expect(restored.results.map((r) => r.status)).toEqual(['failed', 'done', 'done']);
    tickCloneMock(restored, 9000);
    expect(restored.results).toHaveLength(3);
    expect(restored.results[0]!.progress).toBe(46);
  });
  it('精确数量和整数约束，重复点击活动批次不追加重复任务', () => {
    const state = createCloneMock('a');
    state.results = [];
    for (const n of [0, 1.5, 101, NaN]) expect(() => startResults(state, n, 1000)).toThrow();
    startResults(state, 100, 1000);
    expect(state.results).toHaveLength(100);
    expect(() => startResults(state, 1, 1001)).toThrow('等待');
    expect(new Set(state.results.map((r) => r.id)).size).toBe(100);
    expect(JSON.stringify(state).length).toBeLessThan(1_000_000);
  });
});

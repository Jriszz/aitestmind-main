/**
 * 语义指纹与同步引擎单测
 * 纯函数，无数据库依赖：验证指纹稳定性、变更触发、差集计算、孤儿识别、幂等。
 */

import {
  resolveEffectiveSemantics,
  enumerateSemanticItems,
  fingerprintItem,
} from '@/lib/semantics-fingerprint';
import { computeSyncPlan } from '@/lib/semantics-sync';
import type { ApiBusinessSemantics } from '@/types/har';

const API_ID = 'api_test_1';

function confirmed(baseline: any, override?: any): ApiBusinessSemantics {
  return { baseline, override, status: 'confirmed' };
}

describe('resolveEffectiveSemantics', () => {
  it('仅 confirmed 才返回有效语义', () => {
    const sem = { baseline: { description: 'x' }, status: 'draft' } as ApiBusinessSemantics;
    expect(resolveEffectiveSemantics(sem)).toBeNull();
  });

  it('override 逐项覆盖 baseline', () => {
    const sem = confirmed({ description: 'base', sideEffect: { writes: ['t1'] } }, { description: 'ov' });
    const eff = resolveEffectiveSemantics(sem)!;
    expect(eff.description).toBe('ov'); // override 优先
    expect(eff.sideEffect).toEqual({ writes: ['t1'] }); // 未 override 的保留 baseline
  });

  it('接受 JSON 字符串', () => {
    const eff = resolveEffectiveSemantics(JSON.stringify(confirmed({ description: 'x' })))!;
    expect(eff.description).toBe('x');
  });

  it('空/坏数据返回 null', () => {
    expect(resolveEffectiveSemantics(null)).toBeNull();
    expect(resolveEffectiveSemantics('{坏 json')).toBeNull();
  });
});

describe('fingerprintItem 稳定性', () => {
  it('内容实质相等 → 指纹相等（键顺序无关）', () => {
    const a = fingerprintItem(API_ID, 'k', { x: 1, y: 2 });
    const b = fingerprintItem(API_ID, 'k', { y: 2, x: 1 });
    expect(a).toBe(b);
  });

  it('内容改变 → 指纹改变', () => {
    const a = fingerprintItem(API_ID, 'k', { x: 1 });
    const b = fingerprintItem(API_ID, 'k', { x: 2 });
    expect(a).not.toBe(b);
  });

  it('apiId 不同 → 指纹不同', () => {
    expect(fingerprintItem('a', 'k', { x: 1 })).not.toBe(fingerprintItem('b', 'k', { x: 1 }));
  });
});

describe('enumerateSemanticItems 粒度', () => {
  it('每条规则一项：fundConsistency 每键、dbAsserts 每条', () => {
    const eff = resolveEffectiveSemantics(
      confirmed({
        description: '条件约束',
        sideEffect: { writes: ['t1'], queryKey: ['id'] },
        fundConsistency: { 守恒: '可用+冻结==账面', 账平: '借贷相等' },
        dbAsserts: [{ desc: '撤销后置为Cancelled' }, { desc: '余额非负' }],
      })
    );
    const items = enumerateSemanticItems(API_ID, eff);
    const keys = items.map((i) => i.semanticKey).sort();
    expect(keys).toEqual(
      [
        'dbAsserts.撤销后置为Cancelled',
        'dbAsserts.余额非负',
        'description',
        'fundConsistency.守恒',
        'fundConsistency.账平',
        'sideEffect',
      ].sort()
    );
  });

  it('空语义 → 空数组', () => {
    expect(enumerateSemanticItems(API_ID, null)).toEqual([]);
    expect(enumerateSemanticItems(API_ID, resolveEffectiveSemantics(confirmed({})))).toEqual([]);
  });

  it('dbAsserts 重排不改变各自指纹（按 desc 取键）', () => {
    const orderA = enumerateSemanticItems(
      API_ID,
      resolveEffectiveSemantics(confirmed({ dbAsserts: [{ desc: 'A' }, { desc: 'B' }] }))
    );
    const orderB = enumerateSemanticItems(
      API_ID,
      resolveEffectiveSemantics(confirmed({ dbAsserts: [{ desc: 'B' }, { desc: 'A' }] }))
    );
    const fpA = orderA.find((i) => i.semanticKey === 'dbAsserts.A')!.fingerprint;
    const fpB = orderB.find((i) => i.semanticKey === 'dbAsserts.A')!.fingerprint;
    expect(fpA).toBe(fpB);
  });
});

describe('computeSyncPlan 差集与幂等', () => {
  const sem = confirmed({
    fundConsistency: { 守恒: '可用+冻结==账面' },
    sideEffect: { writes: ['t1'] },
  });

  it('首次：全部待生成', () => {
    const plan = computeSyncPlan(API_ID, sem, []);
    expect(plan.hasSemantics).toBe(true);
    expect(plan.toGenerate).toHaveLength(2);
    expect(plan.inSync).toHaveLength(0);
    expect(plan.orphaned).toHaveLength(0);
  });

  it('已全部派生 → 幂等：toGenerate 为空、全部 inSync', () => {
    const all = enumerateSemanticItems(API_ID, resolveEffectiveSemantics(sem));
    const existing = all.map((i) => ({ fingerprint: i.fingerprint, testCaseId: 't_' + i.fingerprint.slice(0, 6) }));
    const plan = computeSyncPlan(API_ID, sem, existing);
    expect(plan.toGenerate).toHaveLength(0);
    expect(plan.inSync).toHaveLength(2);
    expect(plan.orphaned).toHaveLength(0);
  });

  it('规则改变 → 改过的重回待生成，旧指纹进 orphaned', () => {
    const all = enumerateSemanticItems(API_ID, resolveEffectiveSemantics(sem));
    const existing = all.map((i) => ({ fingerprint: i.fingerprint, testCaseId: 'tc_' + i.semanticKey }));

    // 改掉 fundConsistency.守恒 的内容
    const changed = confirmed({
      fundConsistency: { 守恒: '可用+冻结+在途==账面' },
      sideEffect: { writes: ['t1'] },
    });
    const plan = computeSyncPlan(API_ID, changed, existing);

    expect(plan.toGenerate.map((i) => i.semanticKey)).toEqual(['fundConsistency.守恒']);
    expect(plan.inSync.map((i) => i.semanticKey)).toEqual(['sideEffect']);
    expect(plan.orphaned).toHaveLength(1); // 旧守恒指纹失配
  });

  it('删除规则 → 对应已派生进 orphaned，旧用例不被删', () => {
    const all = enumerateSemanticItems(API_ID, resolveEffectiveSemantics(sem));
    const existing = all.map((i) => ({ fingerprint: i.fingerprint, testCaseId: 'tc_' + i.semanticKey }));

    const deleted = confirmed({ sideEffect: { writes: ['t1'] } }); // 去掉 fundConsistency
    const plan = computeSyncPlan(API_ID, deleted, existing);

    expect(plan.toGenerate).toHaveLength(0);
    expect(plan.inSync.map((i) => i.semanticKey)).toEqual(['sideEffect']);
    expect(plan.orphaned).toHaveLength(1);
  });

  it('无 confirmed 语义 → hasSemantics=false，无待生成', () => {
    const plan = computeSyncPlan(API_ID, { baseline: { description: 'x' }, status: 'draft' } as ApiBusinessSemantics, []);
    expect(plan.hasSemantics).toBe(false);
    expect(plan.toGenerate).toHaveLength(0);
  });
});

describe('explore-plan 场景→指纹 映射键（semanticKey 拆/合 round-trip）', () => {
  // explore-plan 用 semanticKey.split('.') 还原 (field, sourceKey) 建索引，
  // 再用场景的 sourceField/sourceKey 反查指纹。验证该拆/合与枚举产物一致。
  const sem = confirmed({
    description: '条件约束',
    sideEffect: { writes: ['t1'] },
    fundConsistency: { '守恒': '可用+冻结==账面' },
    dbAsserts: [{ desc: '撤销后.状态为Cancelled' }], // desc 含点号，验证 rest.join 不丢
  });

  it('按 (apiId, field, sourceKey) 能反查到与枚举一致的指纹', () => {
    const items = enumerateSemanticItems(API_ID, resolveEffectiveSemantics(sem));

    // 模拟 explore-plan 的索引构建
    const index = new Map<string, string>();
    for (const item of items) {
      const [field, ...rest] = item.semanticKey.split('.');
      const sourceKey = rest.join('.') || null;
      index.set(`${API_ID}|${field}|${sourceKey ?? ''}`, item.fingerprint);
    }

    // 模拟场景反查
    const lookup = (field: string, sourceKey: string | null) =>
      index.get(`${API_ID}|${field}|${sourceKey ?? ''}`);

    const byKey = (k: string) => items.find((i) => i.semanticKey === k)!.fingerprint;

    expect(lookup('description', null)).toBe(byKey('description'));
    expect(lookup('sideEffect', null)).toBe(byKey('sideEffect'));
    expect(lookup('fundConsistency', '守恒')).toBe(byKey('fundConsistency.守恒'));
    // desc 含点号：sourceKey 必须是完整 '撤销后.状态为Cancelled'
    expect(lookup('dbAsserts', '撤销后.状态为Cancelled')).toBe(byKey('dbAsserts.撤销后.状态为Cancelled'));
  });
});

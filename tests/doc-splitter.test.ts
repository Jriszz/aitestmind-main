import { splitDocument } from '../lib/doc-splitter';

describe('splitDocument', () => {
  it('按 Markdown 标题切块，每个标题块一段', () => {
    const doc = [
      '# 换汇模块',
      '客户可以提交换汇申请。',
      '## 换汇申请',
      '原币种和目标币种不能相同。',
      '## 换汇撤销',
      '撤销后释放冻结资金。',
    ].join('\n');

    const segs = splitDocument(doc, { segChars: 3000 });
    expect(segs.length).toBe(3);
    expect(segs[0].title).toBe('换汇模块');
    expect(segs[1].title).toBe('换汇申请');
    expect(segs[2].title).toBe('换汇撤销');
    expect(segs[1].content).toContain('不能相同');
  });

  it('无标题纯文本：按段落累积切，且在段落边界断开', () => {
    const para = (n: number) => `段落${n}：` + '内容'.repeat(50); // 每段约 100+ 字
    const doc = [para(1), para(2), para(3), para(4)].join('\n\n');

    const segs = splitDocument(doc, { segChars: 250 });
    // 250 字阈值下，每段约能容 1~2 个 100 字段落，应切成多段
    expect(segs.length).toBeGreaterThan(1);
    // 每段内容都不为空，且不跨越被切碎的句子（以"段落"开头）
    for (const s of segs) {
      expect(s.content.trim().length).toBeGreaterThan(0);
      expect(s.content.trim().startsWith('段落')).toBe(true);
    }
  });

  it('过长标题块：块内按段落二次切', () => {
    const longBody = Array.from({ length: 6 }, (_, i) => `规则${i}：` + '说明'.repeat(40)).join('\n\n');
    const doc = `# 大模块\n${longBody}`;

    const segs = splitDocument(doc, { segChars: 300 });
    expect(segs.length).toBeGreaterThan(1);
    // 二次切出来的段都挂在同一标题下
    for (const s of segs) {
      expect(s.title).toBe('大模块');
    }
  });

  it('空文档 / 纯空白 → 返回空数组', () => {
    expect(splitDocument('', { segChars: 3000 })).toEqual([]);
    expect(splitDocument('   \n\n  ', { segChars: 3000 })).toEqual([]);
  });

  it('过滤空段：标题之间没有正文也不产出空内容段', () => {
    const doc = '# A\n\n# B\n正文B';
    const segs = splitDocument(doc, { segChars: 3000 });
    // A 无正文 → content 退回标题本身；B 有正文
    expect(segs.find((s) => s.title === 'B')?.content).toContain('正文B');
    // 不应出现 content 为纯空白的段
    expect(segs.every((s) => s.content.trim().length > 0)).toBe(true);
  });

  it('单个超长段落：自身独立成段（不硬切句子）', () => {
    const huge = '这是一个很长的段落没有空行' + 'x'.repeat(500);
    const doc = `前言段。\n\n${huge}\n\n后记段。`;
    const segs = splitDocument(doc, { segChars: 200 });
    // 超长段落应作为一整段存在
    expect(segs.some((s) => s.content.includes(huge))).toBe(true);
  });
});

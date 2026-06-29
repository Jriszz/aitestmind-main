/**
 * 需求/功能规格文档切分 —— 把长文档拆成 AI 一次吃得下的段，防 token 爆仓。
 *
 * 策略：
 * 1) 优先按 Markdown 标题（# ~ ######）切块——需求文档天然按功能/章节组织，
 *    一个标题块 ≈ 一个功能模块，对齐"一段≈一个功能"。
 * 2) 标题块仍过长 → 在其内部按段落（空行）累积到 segChars 二次切。
 * 3) 完全无标题结构 → 直接按段落累积切，始终在段落边界断开，不切碎句子。
 *
 * 纯函数、无副作用，便于单测。
 */

export interface DocSegment {
  /** 该段所属标题（若来自标题块），用于给 AI 上下文 */
  title?: string;
  /** 段正文 */
  content: string;
}

const HEADING_RE = /^#{1,6}\s+.*$/;

/** 按段落（空行）累积切分一段文本，在段落边界断开，不超过 segChars */
function splitByParagraph(text: string, segChars: number, title?: string): DocSegment[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const segments: DocSegment[] = [];
  let buf = '';

  const flush = () => {
    const content = buf.trim();
    if (content) segments.push({ title, content });
    buf = '';
  };

  for (const p of paragraphs) {
    // 单个段落本身就超长：自身独立成段（不再硬切句子，交给 AI 容错）
    if (p.length >= segChars) {
      flush();
      segments.push({ title, content: p });
      continue;
    }
    if (buf && buf.length + p.length + 2 > segChars) {
      flush();
    }
    buf = buf ? `${buf}\n\n${p}` : p;
  }
  flush();

  return segments;
}

/**
 * 切分文档为若干段。
 * @param doc 原始文档文本
 * @param opts.segChars 每段目标字数上限（按边界断，可能略小/略大于该值）
 */
export function splitDocument(doc: string, opts: { segChars: number }): DocSegment[] {
  const { segChars } = opts;
  const text = (doc ?? '').trim();
  if (!text) return [];

  const lines = text.split('\n');
  const hasHeadings = lines.some((l) => HEADING_RE.test(l.trim()));

  // 无标题结构 → 直接按段落切
  if (!hasHeadings) {
    return splitByParagraph(text, segChars);
  }

  // 有标题 → 先按标题切块（标题行 + 其下正文，直到下一个标题）
  const blocks: { title?: string; body: string }[] = [];
  let curTitle: string | undefined;
  let curBody: string[] = [];

  const pushBlock = () => {
    const body = curBody.join('\n').trim();
    if (curTitle || body) blocks.push({ title: curTitle, body });
    curBody = [];
  };

  for (const line of lines) {
    if (HEADING_RE.test(line.trim())) {
      pushBlock();
      curTitle = line.trim().replace(/^#{1,6}\s+/, '');
    } else {
      curBody.push(line);
    }
  }
  pushBlock();

  // 每个标题块：短则整块一段，长则块内按段落二次切
  const segments: DocSegment[] = [];
  for (const block of blocks) {
    if (!block.body && !block.title) continue;
    if (block.body.length <= segChars) {
      segments.push({ title: block.title, content: block.body || block.title || '' });
    } else {
      segments.push(...splitByParagraph(block.body, segChars, block.title));
    }
  }

  return segments.filter((s) => (s.content && s.content.trim()) || s.title);
}

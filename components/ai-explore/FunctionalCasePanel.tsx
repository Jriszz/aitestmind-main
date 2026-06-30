'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, FileText, Wand2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import type { FunctionalCase } from '@/types/functional-case';
import { FunctionalCaseReviewList } from './FunctionalCaseReviewList';

// ===== 与后端 route 对齐的常量（仅用于前端预估提示，不影响实际处理） =====
// 这些值改动时务必同步 app/api/ai/functional-cases/generate/route.ts 顶部常量，
// 否则提示与实际行为会脱钩——前端说"预计 12 段"后端却只跑 6 段。
const SEG_CHARS = 3000;
const MAX_DOC_CHARS = 50000;
const SOFT_HINT_THRESHOLD = 10000; // 中性提示阈值
const WARN_THRESHOLD = 30000; // 琥珀色"建议拆分"阈值

/**
 * 文档字数分级提示。
 *
 * 分四档传递准确预期，避免单档"≥8000 字就提示截断"漏掉真正的退化拐点：
 *   - <10000：仅字数（小文档无退化）
 *   - 10000-30000：中性提示分段数（退化轻微）
 *   - 30000-50000：琥珀色，明示覆盖率代价 + 可展开"为什么拆分质量更好"
 *   - ≥50000：红色，明示具体截断字数
 *
 * 拆分提示比工程优化更有效——AI 长上下文的注意力稀释是模型层面的事，
 * 任何分段策略都有代价。让用户按业务模块手动拆，单段语义边界更清晰，质量天差地别。
 */
function DocSizeHint({ length }: { length: number }) {
  const estSegments = Math.max(1, Math.ceil(length / SEG_CHARS));

  if (length < SOFT_HINT_THRESHOLD) {
    return (
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{length} 字</span>
      </div>
    );
  }

  if (length < WARN_THRESHOLD) {
    return (
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{length} 字</span>
        <span>将自动分段处理（约 {estSegments} 段）</span>
      </div>
    );
  }

  if (length < MAX_DOC_CHARS) {
    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-muted-foreground">{length} 字 · 约 {estSegments} 段</span>
        </div>
        <details className="text-[11px] text-amber-700 dark:text-amber-400 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5">
          <summary className="cursor-pointer select-none">
            ⚠️ 文档较长，分段处理会损失约 30% 的覆盖率。建议按业务模块拆成多个文档分别生成。
          </summary>
          <div className="mt-1.5 pt-1.5 border-t border-amber-500/30 text-amber-800/80 dark:text-amber-400/80">
            文档越长，AI 在远端的细节注意力会下降；分段后段间相互看不见对方设计了什么，
            相似需求可能重复或漏掉。按业务模块拆分时，每段的语义边界更清晰，AI 能在
            单次完整通读后统一设计——这是工程层面无法替代的视野。
          </div>
        </details>
      </div>
    );
  }

  // ≥ MAX_DOC_CHARS：必截断
  const droppedChars = length - MAX_DOC_CHARS;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">{length} 字</span>
      </div>
      <div className="text-[11px] text-red-700 dark:text-red-400 rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1.5">
        🛑 文档超过 5 万字，超出部分（约 {droppedChars} 字）将被截断丢失。
        强烈建议按业务模块拆分后分次生成。
      </div>
    </div>
  );
}

/**
 * AI 探索 · 从需求文档生成接口功能用例
 * 文本 → AI 生成「人能理解的接口功能用例」→ 审阅/编辑/勾选 → 探索生成待编排用例。
 */
export function FunctionalCasePanel() {
  const { toast } = useToast();
  const [docText, setDocText] = useState('');
  const [module, setModule] = useState('');
  const [generating, setGenerating] = useState(false);
  const [cases, setCases] = useState<FunctionalCase[]>([]);

  // 长文档分段/截断的回传信息（用于明示提示，不静默）
  const [genInfo, setGenInfo] = useState<{
    segments: number;
    processedSegments: number;
    failedSegments: number;
    truncatedDoc: boolean;
    droppedSegments: number;
    /** 二轮 completeness critic 结果（大文档才会触发） */
    critic?: { ran: boolean; added: number; failed?: boolean; reason?: string };
  } | null>(null);

  const generate = async () => {
    if (docText.trim().length < 10) {
      toast({ title: '请粘贴需求/功能规格文本', description: '至少 10 个字符', variant: 'destructive' });
      return;
    }
    setGenerating(true);
    setCases([]);
    setGenInfo(null);
    try {
      const res = await fetch('/api/ai/functional-cases/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docText, module: module || undefined }),
      });
      const result = await res.json();
      if (!result.success) throw new Error(result.error || '生成失败');
      const list: FunctionalCase[] = result.data.cases || [];
      setCases(list);
      setGenInfo({
        segments: result.data.segments ?? 1,
        processedSegments: result.data.processedSegments ?? 1,
        failedSegments: result.data.failedSegments ?? 0,
        truncatedDoc: !!result.data.truncated?.doc,
        droppedSegments: result.data.truncated?.segments ?? 0,
        critic: result.data.critic,
      });
      if (list.length === 0) {
        toast({ title: '未生成用例', description: '请补充更完整的需求描述后重试' });
      }
    } catch (e: any) {
      toast({ title: '生成失败', description: e.message, variant: 'destructive' });
    } finally {
      setGenerating(false);
    }
  };

  // 警告条：截断/丢段/失败段（琥珀色，需要用户关注）
  const hasWarning =
    !!genInfo && (genInfo.truncatedDoc || genInfo.droppedSegments > 0 || genInfo.failedSegments > 0);
  // 信息条：critic 中性结果（不警告，仅告知"AI 二轮回看做了什么"）
  const criticInfo =
    genInfo?.critic?.ran && !genInfo.critic.failed
      ? genInfo.critic.added > 0
        ? `AI 二轮回看补充了 ${genInfo.critic.added} 条遗漏用例。`
        : `AI 二轮回看未发现明显遗漏。`
      : null;
  const criticFailedInfo = genInfo?.critic?.failed
    ? `二轮回看失败（${genInfo.critic.reason || '未知原因'}），不影响一轮结果。`
    : null;

  const notice =
    genInfo && (hasWarning || criticInfo || criticFailedInfo) ? (
      <div className="space-y-1.5">
        {hasWarning && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400 space-y-1">
            {genInfo.truncatedDoc && <div>⚠️ 文档较长，仅处理了前 5 万字，超出部分未纳入。</div>}
            {genInfo.droppedSegments > 0 && (
              <div>
                ⚠️ 识别到 {genInfo.segments} 个片段，本次仅处理前 {genInfo.processedSegments} 个，
                剩余 {genInfo.droppedSegments} 个可分次处理（删减已生成内容后再粘贴剩余章节）。
              </div>
            )}
            {genInfo.failedSegments > 0 && (
              <div>⚠️ {genInfo.failedSegments} 个片段处理超时/失败，其用例未列出，可重试。</div>
            )}
          </div>
        )}
        {(criticInfo || criticFailedInfo) && (
          <div className="rounded-md border border-blue-500/30 bg-blue-500/5 px-3 py-2 text-xs text-blue-700 dark:text-blue-400">
            {criticInfo && <div>✨ {criticInfo}</div>}
            {criticFailedInfo && <div>ℹ️ {criticFailedInfo}</div>}
          </div>
        )}
      </div>
    ) : null;

  return (
    <div className="flex-1 min-w-0 flex flex-col">
      {/* 文档输入区 */}
      <div className="p-4 border-b border-[#e5e7eb] dark:border-[#4b5563] space-y-3">
        <div className="flex items-center gap-2">
          <FileText className="h-5 w-5 text-fuchsia-600" />
          <h2 className="text-lg font-semibold">从需求文档生成接口功能用例</h2>
          <span className="text-sm text-muted-foreground">
            粘贴需求/功能规格，AI 先产出人能理解的功能用例（可编辑），再探索 API 生成待编排用例。
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={module}
            onChange={(e) => setModule(e.target.value)}
            placeholder="业务模块名（可选，如：换汇）"
            className="h-9 max-w-[240px]"
          />
        </div>
        <Textarea
          value={docText}
          onChange={(e) => setDocText(e.target.value)}
          placeholder="粘贴需求文档 / 功能规格说明……（描述越完整，用例质量越高：主流程、业务规则、异常、状态流转、权限等）"
          className="min-h-[140px] text-sm"
        />
        <DocSizeHint length={docText.length} />
      </div>

      {/* 操作栏 + 用例清单（共享组件） */}
      <div className="flex-1 min-h-0 flex flex-col p-4 pt-3">
        <FunctionalCaseReviewList
          cases={cases}
          setCases={setCases}
          loading={generating}
          loadingHint="AI 正在阅读文档、设计接口功能用例..."
          emptyHint="粘贴需求/功能规格并点击「生成接口功能用例」。"
          notice={notice}
          canReset={docText.length > 0 || module.length > 0 || cases.length > 0}
          onReset={() => {
            setDocText('');
            setModule('');
            setCases([]);
            setGenInfo(null);
          }}
          generateButton={
            <Button onClick={generate} disabled={generating} className="h-9">
              {generating ? (
                <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" />AI 设计中...</>
              ) : (
                <><Wand2 className="mr-1.5 h-4 w-4" />生成接口功能用例</>
              )}
            </Button>
          }
        />
      </div>
    </div>
  );
}

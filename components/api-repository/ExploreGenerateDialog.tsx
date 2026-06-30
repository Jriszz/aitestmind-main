'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Sparkles, Loader2, RefreshCw, ChevronRight, Pencil, Search, Wrench, Trash2, Layers, AlertTriangle, ChevronDown } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

/** 单个候选场景（与 explore-plan 返回结构对齐） */
interface Scenario {
  title: string;
  type: 'normal' | 'param' | 'business' | 'e2e';
  apiIds: string[];
  sourceField?: string | null;
  sourceKey?: string | null;
  rationale: string;
  steps?: string[];
  fingerprint?: string | null;
  alreadyGenerated?: boolean;
}

/**
 * Agent 决策（Level 1 可见化）：把 explore-generate 后端推送的 decision SSE 渲染出来，
 * 让用户实时看到 AI "搜了什么 / 选了哪个接口 / 配没配 cleanup / 最终编排意图"。
 * 与 progress 文本互补：progress 是"现在在干啥"，decision 是"刚刚做了什么决定"。
 */
type DecisionKind =
  | 'search_api'
  | 'select_api'
  | 'cleanup_search'
  | 'assemble'
  | 'assemble_failed';
interface Decision {
  kind: DecisionKind;
  title: string;
  chunkIdx: number;
  caseTitle: string | null;
  detail: any;
  /** 客户端时间戳，仅用于 React key（不依赖服务器单调递增） */
  ts: number;
}

/**
 * 后端 warning SSE 的归集结构。比 decision 更"业务级"：
 *   - missing/extra：本批输入与产出不匹配（AI 漏装或多装）
 *   - max_iterations：迭代上限触发但未产出
 *   - chunk_error：整批失败
 * 与 decisions 并列存放，避免污染决策面板的"AI 主动决策"语义。
 */
interface ChunkWarning {
  chunkIdx: number;
  reason: 'missing' | 'extra' | 'max_iterations' | 'chunk_error';
  content: string;
  missing?: string[];
  extra?: string[];
}

/** summary 阶段服务端汇总的整体失败批清单 */
interface FailedChunk {
  chunkIdx: number;
  error: string;
  titles: string[];
}

interface ExploreGenerateDialogProps {
  apiIds: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 生成完成后回调（用于刷新列表等） */
  onGenerated?: (count: number) => void;
  /**
   * 从需求文档来的功能用例（二选一驱动）：
   * 传入时跳过场景设计阶段，直接对这些功能用例探索 API 并生成待编排用例。
   */
  functionalCases?: any[];
  /** 生成完成后回传"功能用例 → 已生成 TestCase ids"，供上游回填追溯 */
  onFunctionalGenerated?: (createdCases: { id: string; name: string }[]) => void;
}

const TYPE_LABEL: Record<string, { label: string; cls: string }> = {
  normal: { label: '正常', cls: 'bg-green-500/15 text-green-600 dark:text-green-400' },
  param: { label: '参数', cls: 'bg-blue-500/15 text-blue-600 dark:text-blue-400' },
  business: { label: '业务', cls: 'bg-purple-500/15 text-purple-600 dark:text-purple-400' },
  e2e: { label: 'E2E', cls: 'bg-orange-500/15 text-orange-600 dark:text-orange-400' },
};

/**
 * 警告面板：服务端"集合等值校验 / 迭代上限 / 整批失败"等业务级异常。
 *
 * 刻意不与 DecisionPanel 合并：决策面板表达"AI 主动做了什么决定"，警告面板表达
 * "服务端兜底校验出了什么问题"，两者语义不同（决策包含成功路径，警告全是异常路径）。
 * 合并后用户分不清"AI 思考"和"系统报错"，视觉信噪比下降。
 */
function WarningsPanel({
  warnings,
  failedChunks,
}: {
  warnings: ChunkWarning[];
  failedChunks: FailedChunk[];
}) {
  if (warnings.length === 0 && failedChunks.length === 0) return null;

  // 按 chunkIdx 聚合：同一批的 missing/extra/max_iterations 合并显示
  const byChunk = new Map<number, ChunkWarning[]>();
  for (const w of warnings) {
    const arr = byChunk.get(w.chunkIdx) ?? [];
    arr.push(w);
    byChunk.set(w.chunkIdx, arr);
  }
  // failedChunks 也按 chunkIdx 收纳，便于在同一行展示"该批整体失败 + 其细节"
  const failedByChunk = new Map<number, FailedChunk>();
  for (const f of failedChunks) failedByChunk.set(f.chunkIdx, f);

  const allChunks = Array.from(
    new Set<number>([...byChunk.keys(), ...failedByChunk.keys()])
  ).sort((a, b) => a - b);

  return (
    <div className="space-y-1.5">
      {allChunks.map((idx) => {
        const ws = byChunk.get(idx) ?? [];
        const failed = failedByChunk.get(idx);
        const isFatal = !!failed;
        return (
          <div
            key={idx}
            className={`border rounded-md text-xs p-2 ${
              isFatal
                ? 'border-red-500/50 bg-red-500/5 text-red-700 dark:text-red-400'
                : 'border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400'
            }`}
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <div className="flex-1 space-y-1">
                <div className="font-medium">批次 {idx + 1}</div>
                {failed && (
                  <div>
                    <div>整批失败：{failed.error}</div>
                    {failed.titles.length > 0 && (
                      <div className="text-[11px] opacity-80">
                        受影响：{failed.titles.join('、')}
                      </div>
                    )}
                  </div>
                )}
                {ws.map((w, i) => (
                  <div key={i}>
                    <div>{w.content}</div>
                    {w.missing && w.missing.length > 0 && (
                      <div className="text-[11px] opacity-80">
                        缺失：{w.missing.join('、')}
                      </div>
                    )}
                    {w.extra && w.extra.length > 0 && (
                      <div className="text-[11px] opacity-80">
                        非清单内：{w.extra.join('、')}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 决策面板：把 Agent 内部的关键决策点显示给用户，帮助调试和复盘 */
function DecisionPanel({
  decisions,
  realtime,
}: {
  decisions: Decision[];
  /** 生成中实时滚动；完成后只读 */
  realtime: boolean;
}) {
  if (decisions.length === 0) {
    return (
      <div className="text-xs text-muted-foreground py-4 text-center">
        AI 决策将在此实时显示...
      </div>
    );
  }

  // 按 chunkIdx 分组（一批一组）
  const groups = new Map<number, Decision[]>();
  for (const d of decisions) {
    const arr = groups.get(d.chunkIdx) ?? [];
    arr.push(d);
    groups.set(d.chunkIdx, arr);
  }
  const sortedChunks = Array.from(groups.keys()).sort((a, b) => a - b);

  return (
    <div className={`space-y-2 ${realtime ? 'max-h-[420px] overflow-y-auto' : ''}`}>
      {sortedChunks.map((idx) => (
        <div key={idx} className="space-y-1">
          {sortedChunks.length > 1 && (
            <div className="text-[10px] font-medium text-muted-foreground px-1">
              批次 {idx + 1}
            </div>
          )}
          {groups.get(idx)!.map((d) => (
            <DecisionItem key={d.ts} decision={d} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** 单条决策行：图标 + 标题 + 可展开详情。命中 0 / 缺 cleanup 等异常态高亮提示。 */
function DecisionItem({ decision: d }: { decision: Decision }) {
  const [open, setOpen] = useState(false);

  // 根据 kind + detail 选 icon、样式、轻提示
  const meta = (() => {
    if (d.kind === 'search_api') {
      const empty = !!d.detail?.isEmpty;
      return {
        Icon: empty ? AlertTriangle : Search,
        // 命中 0 高亮：Agent 3 最常出错的地方，用户一眼看到
        cls: empty
          ? 'border-red-500/50 bg-red-500/5 text-red-700 dark:text-red-400'
          : 'border-border',
      };
    }
    if (d.kind === 'select_api') {
      // 接口无 paramConstraints && 无 businessSemantics 时弱提示——AI 设计精度可能下降
      const noStructure = !d.detail?.hasConstraints && !d.detail?.hasSemantics;
      return {
        Icon: Wrench,
        cls: noStructure ? 'border-amber-500/40 bg-amber-500/5' : 'border-border',
      };
    }
    if (d.kind === 'cleanup_search') {
      return {
        Icon: Trash2,
        cls: d.detail?.needCleanup === false ? 'border-amber-500/40 bg-amber-500/5' : 'border-border',
      };
    }
    if (d.kind === 'assemble_failed') {
      // 落库失败：红框，与 search_api 0 命中区分（图标用 AlertTriangle 但叠 Layers 语义已丢，
      // 这里直接 AlertTriangle + 红框 + 文案'❌'前缀，让用户能从面板里立刻识别"装失败了"）
      return {
        Icon: AlertTriangle,
        cls: 'border-red-500/50 bg-red-500/5 text-red-700 dark:text-red-400',
      };
    }
    // assemble：节点里如果有 api 节点但 hasCleanup=false，弱提示——可能漏配清理
    const apiCount = Array.isArray(d.detail?.apiNodeIds) ? d.detail.apiNodeIds.length : 0;
    const missCleanup = apiCount > 0 && d.detail?.hasCleanup === false;
    return {
      Icon: Layers,
      cls: missCleanup ? 'border-amber-500/40 bg-amber-500/5' : 'border-border',
    };
  })();

  return (
    <div className={`border rounded-md text-xs ${meta.cls}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-start gap-2 p-2 text-left hover:bg-muted/30 transition-colors"
      >
        <meta.Icon className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <span className="flex-1 break-words">{d.title}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 mt-0.5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="border-t border-border/60 p-2 bg-muted/20">
          <DecisionDetail decision={d} />
        </div>
      )}
    </div>
  );
}

/** 决策详情：按 kind 分别渲染，结构化展示比 JSON dump 直观 */
function DecisionDetail({ decision: d }: { decision: Decision }) {
  if (d.kind === 'search_api') {
    const candidates: any[] = d.detail?.candidates ?? [];
    return (
      <div className="space-y-2">
        <div className="text-[11px] text-muted-foreground">
          关键词：
          {Object.entries(d.detail?.keywords ?? {})
            .map(([k, v]) => `${k}=${v}`)
            .join(' / ') || '(无)'}
        </div>
        {candidates.length === 0 ? (
          <div className="text-[11px] text-red-600 dark:text-red-400">
            未命中候选。AI 可能跳过本步骤或臆造接口，请人工核对生成结果。
          </div>
        ) : (
          <div className="space-y-1">
            <div className="text-[11px] text-muted-foreground">候选（前 {candidates.length}）：</div>
            {candidates.map((c, i) => (
              <div key={i} className="flex items-center gap-2 text-[11px]">
                <span className="font-mono text-muted-foreground">[{c.method}]</span>
                <span className="font-medium truncate">{c.name}</span>
                <span className="text-muted-foreground truncate">{c.path}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (d.kind === 'select_api') {
    return (
      <div className="space-y-1 text-[11px]">
        <div>
          <span className="text-muted-foreground">接口：</span>
          <span className="font-mono">[{d.detail?.method}]</span> {d.detail?.path}
        </div>
        <div className="text-muted-foreground">
          paramConstraints: {d.detail?.hasConstraints ? '✓' : '—'} ·
          businessSemantics: {d.detail?.hasSemantics ? '✓' : '—'}
        </div>
        {!d.detail?.hasConstraints && !d.detail?.hasSemantics && (
          <div className="text-amber-600 dark:text-amber-400">
            该接口无结构化约束/语义，AI 设计精度依赖响应体推断。
          </div>
        )}
      </div>
    );
  }
  if (d.kind === 'cleanup_search') {
    if (d.detail?.needCleanup) {
      return (
        <div className="text-[11px]">
          <span className="text-muted-foreground">删除接口：</span>
          <span className="font-mono">[{d.detail?.deleteApi?.method}]</span>{' '}
          {d.detail?.deleteApi?.name} — {d.detail?.deleteApi?.path}
        </div>
      );
    }
    return (
      <div className="text-[11px] text-muted-foreground">
        {d.detail?.reason || '无需清理'}
      </div>
    );
  }
  if (d.kind === 'assemble_failed') {
    // 落库失败：把"AI 当时打算装什么"和"为什么没成"对齐展示。
    // 这是排错的高价值信息——之前只能看到一条 tool_call:error 不知道编排意图。
    const planned: string[] = Array.isArray(d.detail?.plannedCaseNames)
      ? d.detail.plannedCaseNames
      : [];
    return (
      <div className="space-y-1.5 text-[11px]">
        <div>
          <span className="text-muted-foreground">错误：</span>
          <span className="text-red-600 dark:text-red-400 break-words">
            {d.detail?.error || '未知错误'}
          </span>
        </div>
        {planned.length > 0 && (
          <div>
            <div className="text-muted-foreground">AI 当时打算装的用例：</div>
            <ul className="list-disc list-inside">
              {planned.map((n, i) => (
                <li key={i} className="truncate">
                  {n}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }
  // assemble
  const counts: Record<string, number> = d.detail?.assertionCounts ?? {};
  const noAssertion = Object.entries(counts).filter(([, n]) => !n);
  return (
    <div className="space-y-1 text-[11px]">
      <div>
        <span className="text-muted-foreground">节点数：</span>
        {d.detail?.nodeCount} · API 节点：{d.detail?.apiNodeIds?.length ?? 0}
      </div>
      <div className="text-muted-foreground">
        前置：{d.detail?.hasPreNodes ? '有' : '无'} · 清理：{d.detail?.hasCleanup ? '有' : '无'}
      </div>
      {noAssertion.length > 0 && (
        <div className="text-red-600 dark:text-red-400">
          ⚠️ 以下节点缺断言：{noAssertion.map(([id]) => id).join(', ')}
        </div>
      )}
      {!d.detail?.hasCleanup && (d.detail?.apiNodeIds?.length ?? 0) > 0 && (
        <div className="text-amber-600 dark:text-amber-400">
          未配 cleanup —— 若用例会创建数据，建议人工补清理节点。
        </div>
      )}
    </div>
  );
}

export function ExploreGenerateDialog({
  apiIds,
  open,
  onOpenChange,
  onGenerated,
  functionalCases,
  onFunctionalGenerated,
}: ExploreGenerateDialogProps) {
  const { toast } = useToast();
  const fromFunctional = Array.isArray(functionalCases) && functionalCases.length > 0;
  const [phase, setPhase] = useState<'planning' | 'review' | 'generating' | 'done'>('planning');
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [hidden, setHidden] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [includeGenerated, setIncludeGenerated] = useState(false);
  const [progress, setProgress] = useState<string>('');
  const [createdCount, setCreatedCount] = useState(0);
  const [createdCases, setCreatedCases] = useState<{ id: string; name: string }[]>([]);
  // Agent 决策可见化（Level 1）：实时累计；done 阶段保留供回看
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [decisionsExpanded, setDecisionsExpanded] = useState(false);
  // 警告流：服务端"集合等值校验失败 / 迭代上限 / 整批失败"等业务级异常。
  // 与 decisions 分开，因为这些不是"AI 主动决策"而是"服务端兜底报警"，语义不同。
  const [warnings, setWarnings] = useState<ChunkWarning[]>([]);
  const [failedChunks, setFailedChunks] = useState<FailedChunk[]>([]);
  // 本次"打开"是否已启动过生成/设计——防止父组件重渲染导致 effect 反复触发（死循环根因）。
  const startedRef = useRef(false);

  // 拉取 AI 设计的场景清单
  const fetchPlan = useCallback(
    async (withGenerated: boolean) => {
      setPhase('planning');
      setScenarios([]);
      setSelected(new Set());
      try {
        const res = await fetch('/api/ai/explore-plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiIds, includeGenerated: withGenerated }),
        });
        const result = await res.json();
        if (!result.success) throw new Error(result.error || '场景设计失败');
        const list: Scenario[] = result.data.scenarios || [];
        setScenarios(list);
        setHidden(result.data.hidden || 0);
        setFailedCount(result.data.failedCount || 0);
        // 默认全选未生成过的
        setSelected(new Set(list.map((_, i) => i).filter((i) => !list[i].alreadyGenerated)));
        setPhase('review');
      } catch (e: any) {
        toast({ title: 'AI 探索失败', description: e.message, variant: 'destructive' });
        onOpenChange(false);
      }
    },
    [apiIds, toast, onOpenChange]
  );

  useEffect(() => {
    // 只在"打开"这一次跳变时启动，避免父组件重渲染（如 apiIds={[]} 每次新引用、
    // 生成完成回调里 load() 触发的重渲染）让 effect 反复触发 → 反复生成 → 死循环。
    if (!open) {
      startedRef.current = false;
      return;
    }
    if (startedRef.current) return;
    startedRef.current = true;

    setCreatedCount(0);
    if (fromFunctional) {
      // 从需求文档来的功能用例：跳过场景设计，直接探索 API 并生成
      runGenerate({ functionalCases });
    } else if (apiIds.length > 0) {
      setIncludeGenerated(false);
      fetchPlan(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const toggle = (i: number) => {
    const next = new Set(selected);
    next.has(i) ? next.delete(i) : next.add(i);
    setSelected(next);
  };

  // 统一的 SSE 生成流程（场景清单 / 功能用例 共用）
  async function runGenerate(body: { scenarios?: any[]; functionalCases?: any[] }) {
    setPhase('generating');
    setDecisions([]); // 每次重新生成清空决策列表
    setWarnings([]);
    setFailedChunks([]);
    setDecisionsExpanded(true); // 生成中默认展开决策面板
    setProgress(
      body.functionalCases ? '正在探索接口并按功能用例组装...' : '正在按选定场景组装测试用例...'
    );
    let created = 0;
    let createdList: { id: string; name: string }[] = [];
    try {
      const res = await fetch('/api/ai/explore-generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.body) throw new Error('无响应流');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith('data:')) continue;
          try {
            const msg = JSON.parse(line.slice(5).trim());
            if (msg.type === 'thinking' || msg.type === 'content') {
              if (msg.content) setProgress(msg.content);
            } else if (msg.type === 'tool_call' && msg.data?.progress) {
              setProgress(`${msg.data.progress.message} ${msg.data.progress.detail || ''}`);
            } else if (msg.type === 'decision' && msg.data) {
              // 累计决策（按到达顺序），提供给"生成决策"面板渲染
              setDecisions((prev) => [
                ...prev,
                {
                  kind: msg.data.kind,
                  title: msg.content,
                  chunkIdx: msg.data.chunkIdx ?? 0,
                  caseTitle: msg.data.caseTitle ?? null,
                  detail: msg.data.detail,
                  ts: prev.length, // 单调递增的本地序号即可，不依赖 Date.now
                },
              ]);
            } else if (msg.type === 'warning' && msg.data) {
              // 服务端业务级警告：missing/extra/max_iterations/chunk_error。
              // 不阻断生成，但用户必须看见——之前是静默丢弃。
              setWarnings((prev) => [
                ...prev,
                {
                  chunkIdx: msg.data.chunkIdx ?? 0,
                  reason: msg.data.reason,
                  content: msg.content || '',
                  missing: Array.isArray(msg.data.missing) ? msg.data.missing : undefined,
                  extra: Array.isArray(msg.data.extra) ? msg.data.extra : undefined,
                },
              ]);
            } else if (msg.type === 'summary') {
              created = msg.data?.testCasesCreated || 0;
              createdList = msg.data?.testCases || [];
              // 服务端汇总的失败批次清单（partial recovery 信息）
              if (Array.isArray(msg.data?.failedChunks)) {
                setFailedChunks(msg.data.failedChunks);
              }
            } else if (msg.type === 'error') {
              throw new Error(msg.content);
            }
          } catch {
            /* 忽略半包 */
          }
        }
      }
      setCreatedCount(created);
      setCreatedCases(createdList);
      setPhase('done');
      onGenerated?.(created);
      if (body.functionalCases) onFunctionalGenerated?.(createdList);
      toast({ title: '生成完成', description: `已创建 ${created} 条待编排用例` });
    } catch (e: any) {
      toast({ title: '生成失败', description: e.message, variant: 'destructive' });
      // 功能用例链路没有 review 阶段，失败直接关闭；场景链路退回 review 可重试
      setPhase(body.functionalCases ? 'done' : 'review');
    }
  }

  // 生成选定场景（按 API 范围探索链路）
  const handleGenerate = async () => {
    const chosen = scenarios.filter((_, i) => selected.has(i));
    if (chosen.length === 0) return;
    await runGenerate({ scenarios: chosen });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[760px] max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            AI 探索生成
          </DialogTitle>
          <DialogDescription>
            {fromFunctional
              ? `AI 正在为 ${functionalCases!.length} 条接口功能用例探索匹配 API，并组装成待编排用例。`
              : `AI 自主分析 ${apiIds.length} 个接口的参数约束与业务语义，设计应覆盖的测试场景。你只需挑选，无需描述场景。`}
          </DialogDescription>
        </DialogHeader>

        {/* 设计中 */}
        {phase === 'planning' && (
          <div className="flex-1 flex flex-col items-center justify-center py-16 gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">AI 正在探索接口、设计场景...</p>
          </div>
        )}

        {/* 场景清单审阅 */}
        {phase === 'review' && (
          <>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                AI 设计了 {scenarios.length} 个场景
                {hidden > 0 && `（已隐藏 ${hidden} 个生成过的）`}
              </span>
              <div className="flex items-center gap-3">
                {hidden > 0 && (
                  <label className="flex items-center gap-1.5 cursor-pointer text-xs">
                    <Checkbox
                      checked={includeGenerated}
                      onCheckedChange={(v) => {
                        setIncludeGenerated(!!v);
                        fetchPlan(!!v);
                      }}
                    />
                    显示已生成
                  </label>
                )}
                <Button variant="ghost" size="sm" className="h-7" onClick={() => fetchPlan(includeGenerated)}>
                  <RefreshCw className="h-3.5 w-3.5 mr-1" />
                  让它再发散
                </Button>
              </div>
            </div>

            {failedCount > 0 && (
              <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                <span>
                  ⚠️ {failedCount} 个接口设计超时/失败（多为 AI 调用超时），其场景未列出。可点「让它再发散」重试，或减少一次探索的接口数量。
                </span>
              </div>
            )}

            <div className="flex-1 overflow-y-auto space-y-2 pr-1">
              {scenarios.length === 0 && (
                <div className="text-center py-12 text-sm text-muted-foreground">
                  {failedCount > 0
                    ? '所有接口的场景设计都超时了。请重试，或一次少选几个接口。'
                    : '没有可生成的新场景（该范围的语义场景都已生成）。'}
                </div>
              )}
              {scenarios.map((s, i) => {
                const t = TYPE_LABEL[s.type] || TYPE_LABEL.normal;
                return (
                  <div
                    key={i}
                    className={`border rounded-lg p-3 flex gap-3 cursor-pointer transition-colors ${
                      selected.has(i) ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'
                    }`}
                    onClick={() => toggle(i)}
                  >
                    <Checkbox checked={selected.has(i)} className="mt-1" onCheckedChange={() => toggle(i)} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm">{s.title}</span>
                        <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 ${t.cls}`}>
                          {t.label}
                        </Badge>
                        {s.alreadyGenerated && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-amber-600">
                            已生成
                          </Badge>
                        )}
                        {s.sourceField && (
                          <span className="text-[10px] text-muted-foreground">
                            ← {s.sourceField}
                            {s.sourceKey ? `.${s.sourceKey}` : ''}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">{s.rationale}</p>
                      {s.steps && s.steps.length > 0 && (
                        <div className="flex items-center gap-1 flex-wrap mt-1.5 text-[11px] text-muted-foreground">
                          {s.steps.map((step, k) => (
                            <span key={k} className="flex items-center gap-1">
                              {k > 0 && <ChevronRight className="h-3 w-3" />}
                              {step}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <DialogFooter className="border-t pt-3">
              <p className="text-[11px] text-muted-foreground mr-auto self-center max-w-[300px]">
                注：场景由 AI 据已知约束/语义发散，覆盖已知维度，不代表测试已充分。
              </p>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button onClick={handleGenerate} disabled={selected.size === 0}>
                <Sparkles className="h-4 w-4 mr-1.5" />
                生成选定（{selected.size}）
              </Button>
            </DialogFooter>
          </>
        )}

        {/* 生成中：左侧状态 + 右侧实时决策面板 */}
        {phase === 'generating' && (
          <div className="flex-1 grid grid-cols-[200px_1fr] gap-4 py-4 overflow-hidden">
            <div className="flex flex-col items-center justify-center gap-3 border-r border-border pr-4">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-xs text-muted-foreground text-center">{progress}</p>
            </div>
            <div className="overflow-y-auto pr-1 space-y-3">
              {(warnings.length > 0 || failedChunks.length > 0) && (
                <div>
                  <div className="text-xs font-medium text-amber-600 dark:text-amber-400 mb-1.5 sticky top-0 bg-background pb-1">
                    ⚠️ 警告（{warnings.length + failedChunks.length}）
                  </div>
                  <WarningsPanel warnings={warnings} failedChunks={failedChunks} />
                </div>
              )}
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-2 sticky top-0 bg-background pb-1">
                  AI 生成决策（实时）
                </div>
                <DecisionPanel decisions={decisions} realtime />
              </div>
            </div>
          </div>
        )}

        {/* 完成 */}
        {phase === 'done' && (
          <div className="flex-1 flex flex-col py-6 gap-4 overflow-hidden">
            <div className="flex flex-col items-center gap-2">
              <div className="text-4xl">
                {failedChunks.length > 0 || warnings.length > 0 ? '⚠️' : '🎉'}
              </div>
              <p className="text-sm text-center">
                已创建 {createdCount} 条场景用例。
                {(failedChunks.length > 0 || warnings.length > 0) && (
                  <span className="text-amber-600 dark:text-amber-400">
                    部分批次有警告/失败，请查看下方明细。
                  </span>
                )}
                {failedChunks.length === 0 && warnings.length === 0 && (
                  <>点击任意一条可直接去编排区编辑调整。</>
                )}
              </p>
            </div>

            {/* 警告与失败批：放在最显眼位置，让用户决定要不要重试 */}
            {(warnings.length > 0 || failedChunks.length > 0) && (
              <div className="border border-amber-500/40 rounded-lg p-3 max-h-[200px] overflow-y-auto">
                <div className="text-xs font-medium text-amber-700 dark:text-amber-400 mb-2">
                  本次生成的警告与失败（{warnings.length + failedChunks.length}）
                </div>
                <WarningsPanel warnings={warnings} failedChunks={failedChunks} />
              </div>
            )}

            {/* 决策面板（可折叠回看）：让用户事后能复盘"AI 当时是怎么决定的" */}
            {decisions.length > 0 && (
              <div className="border border-border rounded-lg overflow-hidden">
                <button
                  type="button"
                  onClick={() => setDecisionsExpanded((v) => !v)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted/40 transition-colors"
                >
                  <ChevronDown
                    className={`h-3.5 w-3.5 transition-transform ${decisionsExpanded ? 'rotate-180' : ''}`}
                  />
                  <span className="font-medium">AI 生成决策（{decisions.length} 项）</span>
                  <span className="text-muted-foreground ml-auto">
                    {decisions.some((d) => d.kind === 'search_api' && d.detail?.isEmpty)
                      ? '⚠️ 包含未命中检索，请核对'
                      : '点击展开复盘'}
                  </span>
                </button>
                {decisionsExpanded && (
                  <div className="border-t border-border p-3 max-h-[240px] overflow-y-auto">
                    <DecisionPanel decisions={decisions} realtime={false} />
                  </div>
                )}
              </div>
            )}

            {createdCases.length > 0 && (
              <div className="flex-1 overflow-y-auto space-y-1.5 px-1 max-h-[320px]">
                {createdCases.map((tc) => (
                  <button
                    key={tc.id}
                    onClick={() => {
                      // 一键跳编排区编辑该用例
                      window.open(`/test-orchestration?edit=${tc.id}`, '_blank');
                    }}
                    className="w-full flex items-center justify-between gap-2 border border-border rounded-lg px-3 py-2 text-left text-sm hover:bg-muted/50 hover:border-primary transition-colors group"
                  >
                    <span className="truncate">{tc.name}</span>
                    <span className="flex items-center gap-1 text-xs text-primary opacity-0 group-hover:opacity-100 shrink-0">
                      <Pencil className="h-3.5 w-3.5" />
                      编辑
                    </span>
                  </button>
                ))}
              </div>
            )}

            <div className="flex gap-2 justify-center border-t pt-3">
              <Button variant="ghost" onClick={() => window.open('/test-orchestration', '_blank')}>
                去编排区查看全部
              </Button>
              {!fromFunctional && (
                <Button variant="outline" onClick={() => fetchPlan(includeGenerated)}>
                  继续探索
                </Button>
              )}
              <Button onClick={() => onOpenChange(false)}>完成</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

'use client';

import { useState, useEffect, useCallback } from 'react';
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
import { Sparkles, Loader2, RefreshCw, ChevronRight, Pencil } from 'lucide-react';
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

interface ExploreGenerateDialogProps {
  apiIds: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 生成完成后回调（用于刷新列表等） */
  onGenerated?: (count: number) => void;
}

const TYPE_LABEL: Record<string, { label: string; cls: string }> = {
  normal: { label: '正常', cls: 'bg-green-500/15 text-green-600 dark:text-green-400' },
  param: { label: '参数', cls: 'bg-blue-500/15 text-blue-600 dark:text-blue-400' },
  business: { label: '业务', cls: 'bg-purple-500/15 text-purple-600 dark:text-purple-400' },
  e2e: { label: 'E2E', cls: 'bg-orange-500/15 text-orange-600 dark:text-orange-400' },
};

export function ExploreGenerateDialog({
  apiIds,
  open,
  onOpenChange,
  onGenerated,
}: ExploreGenerateDialogProps) {
  const { toast } = useToast();
  const [phase, setPhase] = useState<'planning' | 'review' | 'generating' | 'done'>('planning');
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [hidden, setHidden] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [includeGenerated, setIncludeGenerated] = useState(false);
  const [progress, setProgress] = useState<string>('');
  const [createdCount, setCreatedCount] = useState(0);
  const [createdCases, setCreatedCases] = useState<{ id: string; name: string }[]>([]);

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
    if (open && apiIds.length > 0) {
      setIncludeGenerated(false);
      setCreatedCount(0);
      fetchPlan(false);
    }
  }, [open, apiIds, fetchPlan]);

  const toggle = (i: number) => {
    const next = new Set(selected);
    next.has(i) ? next.delete(i) : next.add(i);
    setSelected(next);
  };

  // 生成选定场景（SSE）
  const handleGenerate = async () => {
    const chosen = scenarios.filter((_, i) => selected.has(i));
    if (chosen.length === 0) return;
    setPhase('generating');
    setProgress('正在按选定场景组装测试用例...');
    let created = 0;
    let createdList: { id: string; name: string }[] = [];
    try {
      const res = await fetch('/api/ai/explore-generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenarios: chosen }),
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
            } else if (msg.type === 'summary') {
              created = msg.data?.testCasesCreated || 0;
              createdList = msg.data?.testCases || [];
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
      toast({ title: '生成完成', description: `已创建 ${created} 条场景用例` });
    } catch (e: any) {
      toast({ title: '生成失败', description: e.message, variant: 'destructive' });
      setPhase('review');
    }
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
            AI 自主分析 {apiIds.length} 个接口的参数约束与业务语义，设计应覆盖的测试场景。你只需挑选，无需描述场景。
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

        {/* 生成中 */}
        {phase === 'generating' && (
          <div className="flex-1 flex flex-col items-center justify-center py-16 gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground text-center max-w-[420px]">{progress}</p>
          </div>
        )}

        {/* 完成 */}
        {phase === 'done' && (
          <div className="flex-1 flex flex-col py-6 gap-4 overflow-hidden">
            <div className="flex flex-col items-center gap-2">
              <div className="text-4xl">🎉</div>
              <p className="text-sm">
                已创建 {createdCount} 条场景用例。点击任意一条可直接去编排区编辑调整。
              </p>
            </div>

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
              <Button variant="outline" onClick={() => fetchPlan(includeGenerated)}>
                继续探索
              </Button>
              <Button onClick={() => onOpenChange(false)}>完成</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

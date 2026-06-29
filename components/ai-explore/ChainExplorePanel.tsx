'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Loader2,
  Workflow,
  Wand2,
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  Link2,
  Link2Off,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import type { FunctionalCase } from '@/types/functional-case';
import { FunctionalCaseReviewList } from './FunctionalCaseReviewList';

interface ChainNode {
  name: string;
  functionalCaseId?: string;
  functionalCaseTitle?: string; // 展示用
}

type StoredCase = FunctionalCase & { id: string };

/**
 * AI 探索 · 从主干链路发散跨服务接口功能用例（B 方案）
 * 人梳理主干骨架（有序节点 + 可选关联已沉淀用例）→ AI 沿链发散异常/对账/边界 → 审阅/生成。
 */
export function ChainExplorePanel() {
  const { toast } = useToast();
  const [flowName, setFlowName] = useState('');
  const [nodes, setNodes] = useState<ChainNode[]>([{ name: '' }, { name: '' }]);
  const [generating, setGenerating] = useState(false);
  const [cases, setCases] = useState<FunctionalCase[]>([]);
  const [unmatched, setUnmatched] = useState<string[]>([]);
  const [failedCount, setFailedCount] = useState(0);

  // 关联用例弹层
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerNodeIdx, setPickerNodeIdx] = useState<number | null>(null);
  const [library, setLibrary] = useState<StoredCase[]>([]);
  const [libLoading, setLibLoading] = useState(false);
  const [libSearch, setLibSearch] = useState('');

  const loadLibrary = async () => {
    setLibLoading(true);
    try {
      const res = await fetch('/api/functional-cases');
      const result = await res.json();
      if (result.success) setLibrary(result.data || []);
    } catch {
      /* 静默，弹层里有空态 */
    } finally {
      setLibLoading(false);
    }
  };

  useEffect(() => {
    if (pickerOpen && library.length === 0) loadLibrary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerOpen]);

  const setNode = (i: number, patch: Partial<ChainNode>) =>
    setNodes(nodes.map((n, k) => (k === i ? { ...n, ...patch } : n)));
  const addNode = () => setNodes([...nodes, { name: '' }]);
  const removeNode = (i: number) => setNodes(nodes.filter((_, k) => k !== i));
  const moveNode = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= nodes.length) return;
    const next = [...nodes];
    [next[i], next[j]] = [next[j], next[i]];
    setNodes(next);
  };

  const openPicker = (i: number) => {
    setPickerNodeIdx(i);
    setPickerOpen(true);
  };
  const pickCase = (c: StoredCase) => {
    if (pickerNodeIdx === null) return;
    setNode(pickerNodeIdx, { functionalCaseId: c.id, functionalCaseTitle: c.title });
    setPickerOpen(false);
    setPickerNodeIdx(null);
  };

  const generate = async () => {
    if (!flowName.trim()) {
      toast({ title: '请填写业务流名称', variant: 'destructive' });
      return;
    }
    const validNodes = nodes.filter((n) => n.name.trim());
    if (validNodes.length < 2) {
      toast({ title: '主干链路至少需要 2 个节点', variant: 'destructive' });
      return;
    }
    setGenerating(true);
    setCases([]);
    setUnmatched([]);
    setFailedCount(0);
    try {
      const res = await fetch('/api/ai/chain-explore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          flowName,
          nodes: validNodes.map((n) => ({ name: n.name.trim(), functionalCaseId: n.functionalCaseId })),
        }),
      });
      const result = await res.json();
      if (!result.success) throw new Error(result.error || '生成失败');
      setCases(result.data.cases || []);
      setUnmatched(result.data.unmatchedNodes || []);
      setFailedCount(result.data.failedCount || 0);
      if ((result.data.cases || []).length === 0) {
        toast({ title: '未生成用例', description: '请检查主干节点或重试' });
      }
    } catch (e: any) {
      toast({ title: '生成失败', description: e.message, variant: 'destructive' });
    } finally {
      setGenerating(false);
    }
  };

  const filteredLib = library.filter(
    (c) =>
      !libSearch ||
      `${c.title} ${c.module ?? ''} ${c.feature ?? ''}`.toLowerCase().includes(libSearch.toLowerCase())
  );

  const notice =
    unmatched.length > 0 || failedCount > 0 ? (
      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400 space-y-1">
        {unmatched.length > 0 && (
          <div>
            ⚠️ {unmatched.length} 个节点未关联已沉淀用例（{unmatched.join('、')}）：AI 据节点名设计，
            相关预期可能标注「需人工确认」，请审阅时重点核对其业务规则。
          </div>
        )}
        {failedCount > 0 && <div>⚠️ 部分发散调用超时/失败，可重试。</div>}
      </div>
    ) : null;

  return (
    <div className="flex-1 min-w-0 flex flex-col">
      {/* 主干链路输入区 */}
      <div className="p-4 border-b border-[#e5e7eb] dark:border-[#4b5563] space-y-3">
        <div className="flex items-center gap-2">
          <Workflow className="h-5 w-5 text-fuchsia-600" />
          <h2 className="text-lg font-semibold">从主干链路发散跨服务用例</h2>
          <span className="text-sm text-muted-foreground">
            你只梳理主干（有序节点），AI 沿链补全异常、对账、边界——尤其跨服务的失败与一致性。
          </span>
        </div>

        <Input
          value={flowName}
          onChange={(e) => setFlowName(e.target.value)}
          placeholder="业务流名称（如：客户下单冻结购买力）"
          className="h-9 max-w-[360px]"
        />

        {/* 节点序列 */}
        <div className="space-y-1.5">
          {nodes.map((node, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground w-5 shrink-0 text-center">{i + 1}</span>
              <Input
                value={node.name}
                placeholder={`节点 ${i + 1}（如：风控 / 资产-冻结购买力）`}
                className="h-8 text-sm"
                onChange={(e) => setNode(i, { name: e.target.value })}
              />
              {node.functionalCaseId ? (
                <Badge
                  variant="outline"
                  className="text-[10px] gap-1 cursor-pointer shrink-0 max-w-[160px]"
                  title={`已关联：${node.functionalCaseTitle}（点击取消）`}
                  onClick={() => setNode(i, { functionalCaseId: undefined, functionalCaseTitle: undefined })}
                >
                  <Link2 className="h-3 w-3" />
                  <span className="truncate">{node.functionalCaseTitle}</span>
                  <Link2Off className="h-3 w-3" />
                </Badge>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-xs shrink-0 text-muted-foreground"
                  onClick={() => openPicker(i)}
                  title="关联一个已沉淀的接口功能用例（提供该节点的能力/规则）"
                >
                  <Link2 className="h-3.5 w-3.5 mr-1" />
                  关联用例
                </Button>
              )}
              <Button variant="ghost" size="sm" className="h-8 w-7 p-0 shrink-0" onClick={() => moveNode(i, -1)} disabled={i === 0}>
                <ArrowUp className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="sm" className="h-8 w-7 p-0 shrink-0" onClick={() => moveNode(i, 1)} disabled={i === nodes.length - 1}>
                <ArrowDown className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="sm" className="h-8 w-7 p-0 shrink-0" onClick={() => removeNode(i)} disabled={nodes.length <= 2}>
                <Trash2 className="h-3.5 w-3.5 text-destructive" />
              </Button>
            </div>
          ))}
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={addNode}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            添加节点
          </Button>
        </div>
      </div>

      {/* 操作栏 + 用例清单（共享组件） */}
      <div className="flex-1 min-h-0 flex flex-col p-4 pt-3">
        <FunctionalCaseReviewList
          cases={cases}
          setCases={setCases}
          loading={generating}
          loadingHint="AI 正在沿主干链路发散异常 / 对账 / 边界用例..."
          emptyHint="梳理主干节点，点「沿链发散用例」。关联节点用例可让 AI 的预期更准确。"
          notice={notice}
          canReset={
            flowName.length > 0 || nodes.some((n) => n.name.trim() || n.functionalCaseId) || cases.length > 0
          }
          onReset={() => {
            setFlowName('');
            setNodes([{ name: '' }, { name: '' }]);
            setCases([]);
            setUnmatched([]);
            setFailedCount(0);
          }}
          generateButton={
            <Button onClick={generate} disabled={generating} className="h-9">
              {generating ? (
                <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" />AI 发散中...</>
              ) : (
                <><Wand2 className="mr-1.5 h-4 w-4" />沿链发散用例</>
              )}
            </Button>
          }
        />
      </div>

      {/* 关联用例弹层 */}
      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="max-w-[640px] max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>关联接口功能用例</DialogTitle>
            <DialogDescription>
              为该节点选一个已沉淀的用例，作为它的"能力/规则"依据，让 AI 发散时预期更准确。
            </DialogDescription>
          </DialogHeader>
          <Input
            value={libSearch}
            onChange={(e) => setLibSearch(e.target.value)}
            placeholder="搜索用例标题 / 模块"
            className="h-9"
          />
          <div className="flex-1 overflow-y-auto space-y-1.5 mt-2 max-h-[50vh]">
            {libLoading ? (
              <div className="text-center py-10 text-sm text-muted-foreground flex flex-col items-center gap-2">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />加载中...
              </div>
            ) : filteredLib.length === 0 ? (
              <div className="text-center py-10 text-sm text-muted-foreground">
                用例库为空。可先用「从需求文档」生成并保存一些功能用例。
              </div>
            ) : (
              filteredLib.map((c) => (
                <button
                  key={c.id}
                  onClick={() => pickCase(c)}
                  className="w-full text-left border rounded-lg px-3 py-2 hover:bg-muted/50 hover:border-primary transition-colors"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{c.title}</span>
                    {(c.module || c.feature) && (
                      <span className="text-[10px] text-muted-foreground">
                        {[c.module, c.feature].filter(Boolean).join(' / ')}
                      </span>
                    )}
                  </div>
                  {c.objective && <p className="text-xs text-muted-foreground mt-0.5 truncate">{c.objective}</p>}
                </button>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

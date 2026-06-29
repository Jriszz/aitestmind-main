'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { ClipboardList, Search, Plus, Pencil, Trash2, Sparkles, ExternalLink, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useToast } from '@/hooks/use-toast';
import type { FunctionalCase } from '@/types/functional-case';
import { FunctionalCaseEditorSheet } from '@/components/ai-explore/FunctionalCaseEditorSheet';
import { ExploreGenerateDialog } from '@/components/api-repository/ExploreGenerateDialog';

type StoredCase = FunctionalCase & { id: string; updatedAt?: string };

const TYPE_LABEL: Record<string, { label: string; cls: string }> = {
  normal: { label: '正常', cls: 'bg-green-500/15 text-green-600 dark:text-green-400' },
  param: { label: '参数', cls: 'bg-blue-500/15 text-blue-600 dark:text-blue-400' },
  business: { label: '业务', cls: 'bg-purple-500/15 text-purple-600 dark:text-purple-400' },
  e2e: { label: 'E2E', cls: 'bg-orange-500/15 text-orange-600 dark:text-orange-400' },
  permission: { label: '权限', cls: 'bg-rose-500/15 text-rose-600 dark:text-rose-400' },
  state: { label: '状态', cls: 'bg-teal-500/15 text-teal-600 dark:text-teal-400' },
};

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  reviewed: '已评审',
  readyForOrchestration: '待生成',
  generated: '已生成',
};

const EMPTY_CASE: FunctionalCase = {
  title: '',
  type: 'normal',
  priority: 'P2',
  preconditions: [],
  steps: [],
  postconditions: [],
  cleanup: [],
  expectedResults: [],
  businessRules: [],
  apiHints: [],
  status: 'draft',
};

/**
 * 接口用例管理页（/functional-cases）
 * 管理「需求文档 → 接口功能用例」沉淀下来的测试设计资产：列表/筛选/搜索/新建/编辑/删除，
 * 并支持勾选若干用例直接探索生成待编排用例（回填生成追溯）。
 */
export default function FunctionalCasesPage() {
  const { toast } = useToast();
  const [cases, setCases] = useState<StoredCase[]>([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [moduleFilter, setModuleFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const [selected, setSelected] = useState<Set<string>>(new Set());

  // 当前用户是否 admin（批量删除仅 admin 可见可用）
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    try {
      const u = JSON.parse(localStorage.getItem('user') || 'null');
      setIsAdmin(u?.role === 'admin');
    } catch {
      setIsAdmin(false);
    }
  }, []);

  // 编辑/新建抽屉
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<{ value: FunctionalCase; id: string | null } | null>(null);

  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<StoredCase | null>(null);

  // 批量删除二次确认（仅 admin）
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);

  // 探索生成
  const [exploreOpen, setExploreOpen] = useState(false);
  const [exploreCases, setExploreCases] = useState<StoredCase[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/functional-cases');
      const result = await res.json();
      if (!result.success) throw new Error(result.error || '加载失败');
      setCases(result.data || []);
    } catch (e: any) {
      toast({ title: '加载失败', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const modules = useMemo(
    () => Array.from(new Set(cases.map((c) => c.module).filter(Boolean))) as string[],
    [cases]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return cases.filter((c) => {
      if (moduleFilter !== 'all' && (c.module || '') !== moduleFilter) return false;
      if (typeFilter !== 'all' && c.type !== typeFilter) return false;
      if (statusFilter !== 'all' && (c.status || 'draft') !== statusFilter) return false;
      if (q) {
        const hay = `${c.title} ${c.objective ?? ''} ${c.feature ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [cases, search, moduleFilter, typeFilter, statusFilter]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  const toggleAll = () => {
    if (filtered.every((c) => selected.has(c.id)) && filtered.length > 0) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((c) => c.id)));
    }
  };

  // 新建 / 编辑保存
  const handleSave = async (next: FunctionalCase) => {
    try {
      const id = editing?.id;
      if (id) {
        const res = await fetch(`/api/functional-cases/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(next),
        });
        const result = await res.json();
        if (!result.success) throw new Error(result.error || '保存失败');
        toast({ title: '已保存' });
      } else {
        const res = await fetch('/api/functional-cases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cases: [next] }),
        });
        const result = await res.json();
        if (!result.success) throw new Error(result.error || '创建失败');
        toast({ title: '已创建' });
      }
      setEditorOpen(false);
      setEditing(null);
      load();
    } catch (e: any) {
      toast({ title: '保存失败', description: e.message, variant: 'destructive' });
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      const res = await fetch(`/api/functional-cases/${deleteTarget.id}`, { method: 'DELETE' });
      const result = await res.json();
      if (!result.success) throw new Error(result.error || '删除失败');
      toast({ title: '已删除' });
      setDeleteTarget(null);
      load();
    } catch (e: any) {
      toast({ title: '删除失败', description: e.message, variant: 'destructive' });
    }
  };

  const handleBatchDelete = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setBatchDeleting(true);
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
      const res = await fetch('/api/functional-cases', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ ids }),
      });
      const result = await res.json();
      if (!result.success) throw new Error(result.error || '删除失败');
      toast({ title: '已删除', description: `批量删除 ${result.data?.deleted ?? ids.length} 条接口用例` });
      setSelected(new Set());
      setBatchDeleteOpen(false);
      load();
    } catch (e: any) {
      toast({ title: '删除失败', description: e.message, variant: 'destructive' });
    } finally {
      setBatchDeleting(false);
    }
  };

  const startExplore = () => {
    const chosen = cases.filter((c) => selected.has(c.id));
    if (chosen.length === 0) return;
    setExploreCases(chosen);
    setExploreOpen(true);
  };

  // 探索生成完成 → 后端已统一落库并双向回填（generatedCaseIds + status=generated），
  // 前端只需刷新列表即可看到最新状态与追溯。
  const handleFunctionalGenerated = async () => {
    setSelected(new Set());
    load();
  };

  const openGenerated = (ids: string[]) => {
    if (ids.length === 1) {
      window.open(`/test-orchestration?edit=${ids[0]}`, '_blank');
    }
  };

  return (
    <div className="h-full flex flex-col bg-background">
      {/* 顶部 */}
      <div className="p-4 border-b border-[#e5e7eb] dark:border-[#4b5563] space-y-3">
        <div className="flex items-center gap-2">
          <ClipboardList className="h-5 w-5 text-cyan-600" />
          <h1 className="text-lg font-semibold">接口用例</h1>
          <span className="text-sm text-muted-foreground">
            管理从需求文档沉淀的接口功能用例（测试设计层）。可编辑、可探索生成待编排用例。
          </span>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索用例标题 / 目标 / 功能"
              className="pl-9 h-9"
            />
          </div>

          <Select value={moduleFilter} onValueChange={setModuleFilter}>
            <SelectTrigger className="w-[150px] h-9"><SelectValue placeholder="模块" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部模块</SelectItem>
              {modules.map((m) => (
                <SelectItem key={m} value={m}>{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-[130px] h-9"><SelectValue placeholder="类型" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部类型</SelectItem>
              {Object.entries(TYPE_LABEL).map(([k, v]) => (
                <SelectItem key={k} value={k}>{v.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[130px] h-9"><SelectValue placeholder="状态" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              {Object.entries(STATUS_LABEL).map(([k, v]) => (
                <SelectItem key={k} value={k}>{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            variant="outline"
            size="sm"
            className="h-9"
            onClick={() => {
              setEditing({ value: { ...EMPTY_CASE }, id: null });
              setEditorOpen(true);
            }}
          >
            <Plus className="mr-1.5 h-4 w-4" />
            新建用例
          </Button>

          <Button size="sm" className="h-9" onClick={startExplore} disabled={selected.size === 0}>
            <Sparkles className="mr-1.5 h-4 w-4" />
            探索生成待编排（{selected.size}）
          </Button>

          {isAdmin && (
            <Button
              variant="destructive"
              size="sm"
              className="h-9"
              onClick={() => setBatchDeleteOpen(true)}
              disabled={selected.size === 0}
              title="批量删除选中的接口用例（仅管理员）"
            >
              <Trash2 className="mr-1.5 h-4 w-4" />
              批量删除（{selected.size}）
            </Button>
          )}
        </div>

        {filtered.length > 0 && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={filtered.length > 0 && filtered.every((c) => selected.has(c.id))}
              onCheckedChange={toggleAll}
            />
            <span>全选当前（{filtered.length}）</span>
          </div>
        )}
      </div>

      {/* 列表 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {loading ? (
          <div className="text-center py-16 text-sm text-muted-foreground flex flex-col items-center gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            加载中...
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 text-sm text-muted-foreground">
            {cases.length === 0
              ? '还没有接口用例。去「AI 探索 → 从需求文档」生成并保存，或点「新建用例」手工添加。'
              : '没有符合筛选条件的用例。'}
          </div>
        ) : (
          filtered.map((c) => {
            const t = TYPE_LABEL[c.type] || TYPE_LABEL.normal;
            const genIds = c.generatedCaseIds ?? [];
            return (
              <div
                key={c.id}
                className={`border rounded-lg p-3 flex gap-3 transition-colors ${
                  selected.has(c.id) ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'
                }`}
              >
                <Checkbox checked={selected.has(c.id)} className="mt-1" onCheckedChange={() => toggle(c.id)} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{c.title}</span>
                    <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 ${t.cls}`}>{t.label}</Badge>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">{c.priority || 'P2'}</Badge>
                    {c.status === 'generated' && (
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-emerald-600 border-emerald-500/40">
                        已生成
                      </Badge>
                    )}
                    {(c.module || c.feature) && (
                      <span className="text-[10px] text-muted-foreground">
                        {[c.module, c.feature].filter(Boolean).join(' / ')}
                      </span>
                    )}
                  </div>
                  {c.objective && <p className="text-xs text-muted-foreground mt-1">{c.objective}</p>}
                  <div className="flex items-center gap-3 mt-1.5 text-[11px] text-muted-foreground">
                    <span>步骤 {c.steps?.length ?? 0}</span>
                    <span>前置 {c.preconditions?.length ?? 0}</span>
                    <span>后置 {c.postconditions?.length ?? 0}</span>
                    <span>清理 {c.cleanup?.length ?? 0}</span>
                    {genIds.length > 0 && (
                      genIds.length === 1 ? (
                        <button
                          className="flex items-center gap-1 text-primary hover:underline"
                          onClick={() => openGenerated(genIds)}
                        >
                          <ExternalLink className="h-3 w-3" />
                          查看待编排用例
                        </button>
                      ) : (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button className="flex items-center gap-1 text-primary hover:underline">
                              <ExternalLink className="h-3 w-3" />
                              查看待编排用例（{genIds.length}）
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="start">
                            {genIds.map((id, k) => (
                              <DropdownMenuItem
                                key={id}
                                onClick={() => window.open(`/test-orchestration?edit=${id}`, '_blank')}
                              >
                                待编排用例 {k + 1}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )
                    )}
                  </div>
                </div>
                <div className="flex items-start gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    title="编辑"
                    onClick={() => {
                      setEditing({ value: c, id: c.id });
                      setEditorOpen(true);
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    title="删除"
                    onClick={() => setDeleteTarget(c)}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* 编辑 / 新建抽屉 */}
      <FunctionalCaseEditorSheet
        open={editorOpen}
        onOpenChange={(o) => {
          setEditorOpen(o);
          if (!o) setEditing(null);
        }}
        value={editing?.value ?? null}
        onSave={handleSave}
      />

      {/* 删除确认 */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认删除</DialogTitle>
            <DialogDescription>
              确定删除接口用例「<strong>{deleteTarget?.title}</strong>」吗？此操作无法撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>取消</Button>
            <Button variant="destructive" onClick={handleDelete}>删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 批量删除二次确认（仅 admin） */}
      <Dialog open={batchDeleteOpen} onOpenChange={(o) => { if (!batchDeleting) setBatchDeleteOpen(o); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认批量删除</DialogTitle>
            <DialogDescription>
              确定删除选中的 <strong>{selected.size}</strong> 条接口用例吗？已生成的待编排用例不会被删除，但与这些接口用例的追溯关联会丢失。此操作无法撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchDeleteOpen(false)} disabled={batchDeleting}>
              取消
            </Button>
            <Button variant="destructive" onClick={handleBatchDelete} disabled={batchDeleting}>
              {batchDeleting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Trash2 className="mr-1.5 h-4 w-4" />}
              删除 {selected.size} 条
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 探索生成（功能用例入参）+ 回填追溯 */}
      <ExploreGenerateDialog
        apiIds={[]}
        functionalCases={exploreCases}
        open={exploreOpen}
        onOpenChange={setExploreOpen}
        onFunctionalGenerated={handleFunctionalGenerated}
      />
    </div>
  );
}

'use client';

import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Loader2, Sparkles, Pencil, Save, Trash2, Eraser } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import type { FunctionalCase } from '@/types/functional-case';
import { FunctionalCaseEditorSheet } from './FunctionalCaseEditorSheet';
import { ExploreGenerateDialog } from '@/components/api-repository/ExploreGenerateDialog';

const TYPE_LABEL: Record<string, { label: string; cls: string }> = {
  normal: { label: '正常', cls: 'bg-green-500/15 text-green-600 dark:text-green-400' },
  param: { label: '参数', cls: 'bg-blue-500/15 text-blue-600 dark:text-blue-400' },
  business: { label: '业务', cls: 'bg-purple-500/15 text-purple-600 dark:text-purple-400' },
  e2e: { label: 'E2E', cls: 'bg-orange-500/15 text-orange-600 dark:text-orange-400' },
  permission: { label: '权限', cls: 'bg-rose-500/15 text-rose-600 dark:text-rose-400' },
  state: { label: '状态', cls: 'bg-teal-500/15 text-teal-600 dark:text-teal-400' },
};

interface Props {
  cases: FunctionalCase[];
  setCases: (next: FunctionalCase[]) => void;
  /** 顶部操作栏左侧的额外按钮（如各面板自己的"生成"按钮），由父组件传入 */
  generateButton?: ReactNode;
  /** 列表上方提示条（截断/失败/未匹配等） */
  notice?: ReactNode;
  loading?: boolean;
  loadingHint?: string;
  emptyHint?: string;
  /** 清空/重置：由父面板提供，清掉该面板的全部输入与产物。不传则不显示清空按钮。 */
  onReset?: () => void;
  /** 是否有可清空的内容（输入或已生成用例），控制清空按钮是否可点。 */
  canReset?: boolean;
}

/**
 * 接口功能用例·审阅清单（共享）
 * 负责：勾选 / 全选 / 行内编辑（抽屉）/ 删除 / 保存到库 / 探索生成待编排。
 * 文档面板与主干链路面板复用，差别只在"用例从哪来"——由父组件喂 cases。
 */
export function FunctionalCaseReviewList({
  cases,
  setCases,
  generateButton,
  notice,
  loading,
  loadingHint = 'AI 正在设计接口功能用例...',
  emptyHint = '尚无用例。',
  onReset,
  canReset = false,
}: Props) {
  const { toast } = useToast();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [exploreOpen, setExploreOpen] = useState(false);
  const [exploreCases, setExploreCases] = useState<FunctionalCase[]>([]);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);

  const doReset = () => {
    setSelected(new Set());
    setExploreCases([]);
    onReset?.();
    setResetConfirmOpen(false);
  };

  const toggle = (i: number) => {
    const next = new Set(selected);
    next.has(i) ? next.delete(i) : next.add(i);
    setSelected(next);
  };
  const toggleAll = () => {
    if (selected.size === cases.length) setSelected(new Set());
    else setSelected(new Set(cases.map((_, i) => i)));
  };

  const saveSelected = async () => {
    const chosen = cases.filter((_, i) => selected.has(i));
    if (chosen.length === 0) return;
    setSaving(true);
    try {
      const res = await fetch('/api/functional-cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cases: chosen }),
      });
      const result = await res.json();
      if (!result.success) throw new Error(result.error || '保存失败');
      toast({ title: '已保存到用例库', description: `${chosen.length} 条接口功能用例` });
    } catch (e: any) {
      toast({ title: '保存失败', description: e.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const exploreGenerate = () => {
    const chosen = cases.filter((_, i) => selected.has(i));
    if (chosen.length === 0) return;
    setExploreCases(chosen);
    setExploreOpen(true);
  };

  const removeAt = (i: number) => {
    setCases(cases.filter((_, k) => k !== i));
    const next = new Set<number>();
    selected.forEach((s) => {
      if (s < i) next.add(s);
      else if (s > i) next.add(s - 1);
    });
    setSelected(next);
  };

  return (
    <>
      {/* 操作栏 */}
      <div className="flex items-center gap-2 flex-wrap">
        {generateButton}
        {cases.length > 0 && (
          <>
            <Button variant="outline" size="sm" className="h-9" onClick={toggleAll}>
              {selected.size === cases.length ? '取消全选' : '全选'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9"
              onClick={saveSelected}
              disabled={saving || selected.size === 0}
            >
              {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
              保存到用例库（{selected.size}）
            </Button>
            <Button size="sm" className="h-9" onClick={exploreGenerate} disabled={selected.size === 0}>
              <Sparkles className="mr-1.5 h-4 w-4" />
              探索生成待编排（{selected.size}）
            </Button>
          </>
        )}
        {onReset && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9 ml-auto text-muted-foreground hover:text-destructive"
            onClick={() => setResetConfirmOpen(true)}
            disabled={loading || !canReset}
            title="清空当前输入与已生成的用例，重新开始"
          >
            <Eraser className="mr-1.5 h-4 w-4" />
            清空
          </Button>
        )}
      </div>

      {/* 清单 */}
      <div className="flex-1 overflow-y-auto pt-3 space-y-2">
        {notice}
        {loading && cases.length === 0 && (
          <div className="text-center py-16 text-sm text-muted-foreground flex flex-col items-center gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            {loadingHint}
          </div>
        )}
        {!loading && cases.length === 0 && (
          <div className="text-center py-16 text-sm text-muted-foreground">{emptyHint}</div>
        )}
        {cases.map((c, i) => {
          const t = TYPE_LABEL[c.type] || TYPE_LABEL.normal;
          return (
            <div
              key={i}
              className={`border rounded-lg p-3 flex gap-3 transition-colors ${
                selected.has(i) ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'
              }`}
            >
              <Checkbox checked={selected.has(i)} className="mt-1" onCheckedChange={() => toggle(i)} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm">{c.title}</span>
                  <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 ${t.cls}`}>{t.label}</Badge>
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0">{c.priority || 'P2'}</Badge>
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
                </div>
              </div>
              <div className="flex items-start gap-1">
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" title="编辑" onClick={() => setEditIndex(i)}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" title="删除" onClick={() => removeAt(i)}>
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {/* 编辑抽屉 */}
      <FunctionalCaseEditorSheet
        open={editIndex !== null}
        onOpenChange={(o) => { if (!o) setEditIndex(null); }}
        value={editIndex !== null ? cases[editIndex] : null}
        onSave={(next) => {
          if (editIndex === null) return;
          setCases(cases.map((c, k) => (k === editIndex ? next : c)));
          setEditIndex(null);
        }}
      />

      {/* 探索生成（功能用例入参）。后端会把选中用例沉淀入库（status=generated）并双向回填追溯。 */}
      <ExploreGenerateDialog
        apiIds={[]}
        functionalCases={exploreCases}
        open={exploreOpen}
        onOpenChange={setExploreOpen}
        onFunctionalGenerated={() =>
          toast({
            title: '已沉淀到接口用例库',
            description: '生成的待编排用例可在编排区查看；功能用例已存入「接口用例」。',
          })
        }
      />

      {/* 清空确认 */}
      <AlertDialog open={resetConfirmOpen} onOpenChange={setResetConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清空当前内容？</AlertDialogTitle>
            <AlertDialogDescription>
              将清除当前输入与本次生成的全部用例（尚未「保存到用例库」的内容会丢失，已保存的不受影响）。此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={doReset}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              清空
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

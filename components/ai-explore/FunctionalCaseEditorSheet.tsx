'use client';

import { useEffect, useState } from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Plus, Trash2, GripVertical } from 'lucide-react';
import type { FunctionalCase, FunctionalStep } from '@/types/functional-case';

const TYPE_OPTIONS = [
  { value: 'normal', label: '正常场景' },
  { value: 'param', label: '参数校验' },
  { value: 'business', label: '业务语义' },
  { value: 'e2e', label: 'E2E流程' },
  { value: 'permission', label: '权限校验' },
  { value: 'state', label: '状态流转' },
];
const PRIORITY_OPTIONS = ['P0', 'P1', 'P2', 'P3'];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: FunctionalCase | null;
  /** 保存编辑后的用例（已落库的传 id；未落库的草稿无 id，由父组件就地替换） */
  onSave: (next: FunctionalCase) => void;
}

/** 可增删的字符串列表编辑器 */
function StringListEditor({
  label,
  items,
  placeholder,
  onChange,
}: {
  label: string;
  items: string[];
  placeholder?: string;
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs font-medium">{label}</Label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => onChange([...items, ''])}
        >
          <Plus className="h-3 w-3 mr-1" />
          添加
        </Button>
      </div>
      {items.length === 0 && (
        <p className="text-[11px] text-muted-foreground">（空）</p>
      )}
      <div className="space-y-1.5">
        {items.map((it, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Input
              value={it}
              placeholder={placeholder}
              className="h-8 text-sm"
              onChange={(e) => {
                const next = [...items];
                next[i] = e.target.value;
                onChange(next);
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 shrink-0"
              onClick={() => onChange(items.filter((_, k) => k !== i))}
            >
              <Trash2 className="h-3.5 w-3.5 text-destructive" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function FunctionalCaseEditorSheet({ open, onOpenChange, value, onSave }: Props) {
  const [draft, setDraft] = useState<FunctionalCase | null>(value);

  useEffect(() => {
    setDraft(value ? JSON.parse(JSON.stringify(value)) : null);
  }, [value, open]);

  if (!draft) return null;

  const set = (patch: Partial<FunctionalCase>) => setDraft({ ...draft, ...patch });

  const steps = draft.steps ?? [];
  const setStep = (i: number, patch: Partial<FunctionalStep>) => {
    const next = steps.map((s, k) => (k === i ? { ...s, ...patch } : s));
    set({ steps: next });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl flex flex-col p-0">
        <SheetHeader className="px-6 pt-6">
          <SheetTitle>编辑接口功能用例</SheetTitle>
          <SheetDescription>测试设计层（人能理解，不可执行）。确认后由 AI 探索 API 生成待编排用例。</SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {/* 标题 */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">用例名称</Label>
            <Input
              value={draft.title}
              className="h-9"
              onChange={(e) => set({ title: e.target.value })}
            />
          </div>

          {/* 模块 / 功能 */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">业务模块</Label>
              <Input
                value={draft.module ?? ''}
                className="h-9"
                placeholder="如：换汇"
                onChange={(e) => set({ module: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">功能</Label>
              <Input
                value={draft.feature ?? ''}
                className="h-9"
                placeholder="如：换汇申请"
                onChange={(e) => set({ feature: e.target.value })}
              />
            </div>
          </div>

          {/* 类型 / 优先级 */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">类型</Label>
              <Select value={draft.type} onValueChange={(v) => set({ type: v as FunctionalCase['type'] })}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TYPE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">优先级</Label>
              <Select value={draft.priority ?? 'P2'} onValueChange={(v) => set({ priority: v as FunctionalCase['priority'] })}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PRIORITY_OPTIONS.map((p) => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* 目标 */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">测试目标</Label>
            <Textarea
              value={draft.objective ?? ''}
              className="min-h-[56px] text-sm"
              placeholder="一句话说明这条用例验证什么"
              onChange={(e) => set({ objective: e.target.value })}
            />
          </div>

          <StringListEditor
            label="前置条件"
            items={draft.preconditions ?? []}
            placeholder="如：用户已登录"
            onChange={(v) => set({ preconditions: v })}
          />

          {/* 结构化步骤 */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium">测试步骤</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => set({ steps: [...steps, { action: '' }] })}
              >
                <Plus className="h-3 w-3 mr-1" />
                添加步骤
              </Button>
            </div>
            {steps.length === 0 && <p className="text-[11px] text-muted-foreground">（空）</p>}
            <div className="space-y-2">
              {steps.map((s, i) => (
                <div key={i} className="rounded-lg border p-2.5 space-y-2 bg-muted/20">
                  <div className="flex items-center gap-1.5">
                    <GripVertical className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="text-[11px] text-muted-foreground shrink-0">步骤 {i + 1}</span>
                    <Input
                      value={s.action}
                      placeholder="操作（如：提交换汇申请）"
                      className="h-8 text-sm"
                      onChange={(e) => setStep(i, { action: e.target.value })}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0 shrink-0"
                      onClick={() => set({ steps: steps.filter((_, k) => k !== i) })}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 gap-2 pl-5">
                    <Input
                      value={s.input ?? ''}
                      placeholder="输入/参数（如：USD换HKD,100）"
                      className="h-8 text-xs"
                      onChange={(e) => setStep(i, { input: e.target.value })}
                    />
                    <Input
                      value={s.expected ?? ''}
                      placeholder="该步预期（如：返回申请单号）"
                      className="h-8 text-xs"
                      onChange={(e) => setStep(i, { expected: e.target.value })}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <StringListEditor
            label="后置验证"
            items={draft.postconditions ?? []}
            placeholder="如：再次查询余额，USD可用余额应减少"
            onChange={(v) => set({ postconditions: v })}
          />
          <StringListEditor
            label="数据清理"
            items={draft.cleanup ?? []}
            placeholder="如：撤销本次申请，释放冻结资金"
            onChange={(v) => set({ cleanup: v })}
          />
          <StringListEditor
            label="预期结果"
            items={draft.expectedResults ?? []}
            placeholder="如：生成换汇申请单"
            onChange={(v) => set({ expectedResults: v })}
          />
          <StringListEditor
            label="覆盖的业务规则"
            items={draft.businessRules ?? []}
            placeholder="如：原币种与目标币种不能相同"
            onChange={(v) => set({ businessRules: v })}
          />
          <StringListEditor
            label="接口关键词（供 AI 探索检索）"
            items={draft.apiHints ?? []}
            placeholder="如：换汇申请提交"
            onChange={(v) => set({ apiHints: v })}
          />
        </div>

        <SheetFooter className="px-6 py-4 border-t">
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button
            onClick={() => {
              onSave(draft);
              onOpenChange(false);
            }}
          >
            保存
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

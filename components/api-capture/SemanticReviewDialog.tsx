'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import type { SemanticField, SemanticFieldDiff } from '@/lib/semantics-diff';

/** 单个接口的语义变更评审项 */
export interface SemanticReviewItem {
  apiKey: string; // method|path，用于回写决策
  apiName: string;
  method: string;
  path: string;
  diffs: SemanticFieldDiff[];
}

/** 用户对单个接口各字段的决策 */
export interface SemanticReviewDecision {
  apiKey: string;
  decisions: Array<{ field: SemanticField; resolution: 'accept' | 'keepOld' | 'keepOverride' }>;
}

interface SemanticReviewDialogProps {
  open: boolean;
  items: SemanticReviewItem[];
  onResolve: (decisions: SemanticReviewDecision[]) => void;
  onCancel: () => void;
}

const FIELD_LABELS: Record<SemanticField, string> = {
  description: '条件约束 (description)',
  sideEffect: '落库副作用 (x-side-effect)',
  fundConsistency: '资金一致性 (x-fund-consistency)',
  dbAsserts: '数据库断言 (x-db-asserts)',
};

const TYPE_LABELS: Record<SemanticFieldDiff['type'], string> = {
  added: '文档新增',
  changed: '文档变更',
  removed: '文档删除',
};

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '（无）';
  if (typeof v === 'string') return v;
  return JSON.stringify(v, null, 2);
}

/**
 * 业务语义变更评审对话框（三栏对比 + 逐项决策）
 * 文档为主、平台可调：变更不静默合并，逐个接口、逐字段让用户确认。
 */
export function SemanticReviewDialog({ open, items, onResolve, onCancel }: SemanticReviewDialogProps) {
  // resolution[apiKey][field] = 'accept' | 'keepOld' | 'keepOverride'
  const [choices, setChoices] = useState<Record<string, Record<string, string>>>({});

  if (!open || items.length === 0) return null;

  const setChoice = (apiKey: string, field: string, value: string) => {
    setChoices((prev) => ({ ...prev, [apiKey]: { ...(prev[apiKey] || {}), [field]: value } }));
  };

  const getChoice = (apiKey: string, field: string, hasOverride: boolean) =>
    choices[apiKey]?.[field] ?? (hasOverride ? 'keepOverride' : 'accept');

  const handleConfirm = () => {
    const result: SemanticReviewDecision[] = items.map((item) => ({
      apiKey: item.apiKey,
      decisions: item.diffs.map((d) => ({
        field: d.field,
        resolution: getChoice(item.apiKey, d.field, d.hasOverride) as
          | 'accept'
          | 'keepOld'
          | 'keepOverride',
      })),
    }));
    onResolve(result);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-[860px] h-[85vh] flex flex-col p-0">
        <div className="px-6 pt-6">
          <DialogHeader>
            <DialogTitle>业务语义变更评审</DialogTitle>
            <DialogDescription>
              检测到 {items.length} 个接口的业务语义有变更。文档为权威基线，请逐项确认如何处理（变更不会静默覆盖）。
            </DialogDescription>
          </DialogHeader>
        </div>

        <ScrollArea className="flex-1 px-6 py-4 min-h-0">
          <div className="space-y-6">
            {items.map((item) => (
              <div key={item.apiKey} className="border border-[#e5e7eb] dark:border-[#4b5563] rounded-lg p-4 space-y-4">
                <div className="flex items-center gap-2">
                  <Badge>{item.method}</Badge>
                  <span className="font-medium text-sm">{item.apiName}</span>
                  <span className="text-xs text-muted-foreground font-mono">{item.path}</span>
                </div>

                {item.diffs.map((d) => (
                  <div key={d.field} className="space-y-2 border-t border-dashed pt-3">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">{FIELD_LABELS[d.field]}</span>
                      <Badge variant="outline" className="text-xs">{TYPE_LABELS[d.type]}</Badge>
                      {d.hasOverride && (
                        <Badge variant="destructive" className="text-xs">存在平台调整 · 冲突</Badge>
                      )}
                    </div>

                    {/* 三栏对比 */}
                    <div className="grid grid-cols-3 gap-2 text-xs">
                      <div>
                        <div className="text-muted-foreground mb-1">文档旧</div>
                        <pre className="bg-muted/40 rounded p-2 whitespace-pre-wrap break-words max-h-40 overflow-auto">{fmt(d.old)}</pre>
                      </div>
                      <div>
                        <div className="text-muted-foreground mb-1">文档新</div>
                        <pre className="bg-muted/40 rounded p-2 whitespace-pre-wrap break-words max-h-40 overflow-auto">{fmt(d.new)}</pre>
                      </div>
                      <div>
                        <div className="text-muted-foreground mb-1">平台调整</div>
                        <pre className="bg-muted/40 rounded p-2 whitespace-pre-wrap break-words max-h-40 overflow-auto">{d.hasOverride ? fmt(d.overrideValue) : '（无）'}</pre>
                      </div>
                    </div>

                    {/* 决策 */}
                    <RadioGroup
                      value={getChoice(item.apiKey, d.field, d.hasOverride)}
                      onValueChange={(v) => setChoice(item.apiKey, d.field, v)}
                      className="flex flex-wrap gap-4 pt-1"
                    >
                      <div className="flex items-center gap-2">
                        <RadioGroupItem value="accept" id={`${item.apiKey}-${d.field}-accept`} />
                        <Label htmlFor={`${item.apiKey}-${d.field}-accept`} className="text-xs cursor-pointer">采纳文档新值</Label>
                      </div>
                      <div className="flex items-center gap-2">
                        <RadioGroupItem value="keepOld" id={`${item.apiKey}-${d.field}-keepOld`} />
                        <Label htmlFor={`${item.apiKey}-${d.field}-keepOld`} className="text-xs cursor-pointer">保留文档旧值</Label>
                      </div>
                      {d.hasOverride && (
                        <div className="flex items-center gap-2">
                          <RadioGroupItem value="keepOverride" id={`${item.apiKey}-${d.field}-keepOverride`} />
                          <Label htmlFor={`${item.apiKey}-${d.field}-keepOverride`} className="text-xs cursor-pointer">保留平台调整</Label>
                        </div>
                      )}
                    </RadioGroup>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </ScrollArea>

        <div className="px-6 py-4 border-t border-[#e5e7eb] dark:border-[#4b5563] bg-background">
          <DialogFooter>
            <Button variant="outline" onClick={onCancel}>取消</Button>
            <Button onClick={handleConfirm}>确认应用</Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

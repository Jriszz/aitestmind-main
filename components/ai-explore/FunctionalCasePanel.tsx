'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, FileText, Wand2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import type { FunctionalCase } from '@/types/functional-case';
import { FunctionalCaseReviewList } from './FunctionalCaseReviewList';

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

  const notice =
    genInfo && (genInfo.truncatedDoc || genInfo.droppedSegments > 0 || genInfo.failedSegments > 0) ? (
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
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{docText.length} 字</span>
          {docText.length > 8000 && (
            <span className="text-amber-600">
              文档较长，将自动分段处理（可能稍等）；超过 5 万字的部分会被截断。
            </span>
          )}
        </div>
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

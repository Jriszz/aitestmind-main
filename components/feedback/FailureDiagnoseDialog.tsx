"use client";

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, AlertCircle, CheckCircle2, XCircle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

/**
 * AI 失败归因弹窗
 *
 * 触发：执行详情页的失败用例行点击「AI 归因」
 * 流程：
 *   1. 调 POST /api/ai/diagnose-failure（SSE）
 *   2. 流式展示 AI 推理 + 工具调用 + 最终归因
 *   3. 用户对归因结论决策：确认（→ acknowledged）/ 不准（→ wontfix）
 *
 * 关键：归因落库时 status=open，必须由用户在此弹窗 / 评审页确认才生效
 */

interface FailureDiagnoseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  caseExecutionId: string;
  caseName?: string;
}

interface Diagnosis {
  feedbackId: string;
  category: string;
  summary: string;
  detail: string;
  suggestion: string | null;
}

const CATEGORY_LABELS: Record<string, { label: string; color: string }> = {
  api_path_changed: { label: '接口变更', color: 'bg-orange-100 text-orange-700' },
  assertion_wrong: { label: '断言写错', color: 'bg-yellow-100 text-yellow-700' },
  param_constraint_missed: { label: '参数约束遗漏', color: 'bg-blue-100 text-blue-700' },
  business_code_assumption: { label: '业务码假设错', color: 'bg-purple-100 text-purple-700' },
  missing_precondition: { label: '缺前置数据', color: 'bg-pink-100 text-pink-700' },
  wrong_variable_ref: { label: '变量引用错', color: 'bg-cyan-100 text-cyan-700' },
  other: { label: '其他', color: 'bg-gray-100 text-gray-700' },
};

export default function FailureDiagnoseDialog({
  open,
  onOpenChange,
  caseExecutionId,
  caseName,
}: FailureDiagnoseDialogProps) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [streamLogs, setStreamLogs] = useState<Array<{ type: string; content: string }>>([]);
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setLoading(false);
    setStreamLogs([]);
    setDiagnosis(null);
    setError(null);
  };

  const handleClose = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const startDiagnose = async () => {
    reset();
    setLoading(true);

    try {
      const response = await fetch('/api/ai/diagnose-failure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseExecutionId }),
      });

      if (!response.ok || !response.body) {
        throw new Error(`请求失败: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (!payload) continue;

          try {
            const msg = JSON.parse(payload);
            if (msg.type === 'diagnosis') {
              setDiagnosis(msg.data);
            } else if (msg.type === 'error') {
              setError(msg.content);
            } else {
              setStreamLogs((prev) => [...prev, { type: msg.type, content: msg.content }]);
            }
          } catch (e) {
            console.warn('SSE 解析失败:', payload, e);
          }
        }
      }
    } catch (e: any) {
      setError(e.message || '归因失败');
    } finally {
      setLoading(false);
    }
  };

  // 归因落库后，评审动作转移到「用例编排」页的反馈历史 Sheet
  // 这里的弹窗只负责"看结论"，不再承担评审职责（避免在执行监控页塞用例编辑语义）

  const categoryMeta = diagnosis ? CATEGORY_LABELS[diagnosis.category] || CATEGORY_LABELS.other : null;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertCircle className="w-5 h-5 text-orange-500" />
            AI 失败归因
          </DialogTitle>
          <DialogDescription>
            {caseName ? `分析用例「${caseName}」的失败原因` : '让 AI 分析失败原因，结论需要你确认后才生效'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-3 py-2">
          {/* 初始态：未开始 */}
          {!loading && streamLogs.length === 0 && !diagnosis && !error && (
            <div className="text-sm text-muted-foreground p-4 rounded-md bg-muted/50">
              点击下方「开始归因」让 AI 对比快照与接口当前真相，定位失败根因。AI 给出的结论不会自动生效，
              需要你确认后才会被未来的生成调用看到。
            </div>
          )}

          {/* 流式日志 */}
          {streamLogs.length > 0 && (
            <div className="text-xs space-y-1 p-3 rounded-md bg-muted/30 max-h-40 overflow-y-auto font-mono">
              {streamLogs.map((log, idx) => (
                <div key={idx} className="text-muted-foreground">
                  <span className="text-blue-500">[{log.type}]</span> {log.content}
                </div>
              ))}
            </div>
          )}

          {/* 错误 */}
          {error && (
            <div className="p-4 rounded-md bg-red-50 border border-red-200 text-sm text-red-700">
              <strong>归因失败：</strong>
              {error}
            </div>
          )}

          {/* 最终归因结论 */}
          {diagnosis && categoryMeta && (
            <div className="space-y-3 p-4 rounded-md border border-primary/20 bg-primary/5">
              <div className="flex items-center gap-2">
                <Badge className={categoryMeta.color}>{categoryMeta.label}</Badge>
                <span className="text-xs text-muted-foreground">{diagnosis.category}</span>
              </div>

              <div>
                <div className="text-xs text-muted-foreground mb-1">一句话归因</div>
                <div className="text-sm font-medium">{diagnosis.summary}</div>
              </div>

              <div>
                <div className="text-xs text-muted-foreground mb-1">详细推理</div>
                <div className="text-sm whitespace-pre-wrap">{diagnosis.detail}</div>
              </div>

              {diagnosis.suggestion && (
                <div>
                  <div className="text-xs text-muted-foreground mb-1">未来生成时怎么避坑</div>
                  <div className="text-sm whitespace-pre-wrap text-emerald-700">{diagnosis.suggestion}</div>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="flex-shrink-0">
          {!diagnosis && !loading && (
            <Button onClick={startDiagnose} disabled={loading}>
              开始归因
            </Button>
          )}
          {loading && (
            <Button disabled>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              AI 分析中...
            </Button>
          )}
          {diagnosis && (
            <div className="text-sm text-muted-foreground p-3 rounded bg-muted/50">
              归因已记录。请前往「用例编排」页打开此用例的反馈历史进行评审。
              评审通过后，AI 生成时会自动避开此问题。
            </div>
          )}
          {diagnosis && (
            <Button onClick={onOpenChange}>
              <CheckCircle2 className="w-4 h-4 mr-1" />
              知道了
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CheckCircle2, XCircle, Loader2, Plus, AlertCircle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

/**
 * 反馈面板（复用组件）
 *
 * 三种过滤模式：
 *   - 节点级：传 stepNodeId + apiId
 *   - 用例级：传 testCaseId
 *   - 接口级：传 apiId（功能用例页用）
 *
 * 功能：
 *   1. 列表展示该范围内的反馈（按时间倒序）
 *   2. 评审动作：acknowledged / wontfix / fixed
 *   3. 主动反馈：展开表单快速创建 user_comment 类型反馈
 */

interface FeedbackPanelProps {
  testCaseId?: string;
  apiId?: string;
  stepNodeId?: string;
  title?: string; // 面板标题，如 "节点反馈" / "用例反馈"
}

interface Feedback {
  id: string;
  source: string;
  category: string;
  targetField: string | null;
  summary: string;
  detail: string | null;
  suggestion: string | null;
  status: string;
  consumedCount: number;
  createdAt: string;
  testCase: { id: string; name: string } | null;
  api: { id: string; name: string; method: string; path: string } | null;
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

const SOURCE_LABELS: Record<string, string> = {
  execution_failure: 'AI 归因',
  user_edit: '用户编辑',
  ai_self_critic: 'AI 自检',
  user_comment: '用户吐槽',
};

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  open: { label: '待评审', color: 'bg-amber-100 text-amber-700' },
  acknowledged: { label: '已采纳', color: 'bg-emerald-100 text-emerald-700' },
  fixed: { label: '已修复', color: 'bg-sky-100 text-sky-700' },
  wontfix: { label: '误报', color: 'bg-gray-100 text-gray-500' },
};

export default function FeedbackPanel({
  testCaseId,
  apiId,
  stepNodeId,
  title = '反馈历史',
}: FeedbackPanelProps) {
  const { toast } = useToast();
  const [items, setItems] = useState<Feedback[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // 主动反馈表单
  const [showAddForm, setShowAddForm] = useState(false);
  const [addCategory, setAddCategory] = useState<string>('other');
  const [addSummary, setAddSummary] = useState('');
  const [addDetail, setAddDetail] = useState('');
  const [addLoading, setAddLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (testCaseId) params.set('testCaseId', testCaseId);
      if (apiId) params.set('apiId', apiId);
      if (stepNodeId) params.set('stepNodeId', stepNodeId);
      params.set('pageSize', '20');

      const resp = await fetch(`/api/feedback?${params.toString()}`);
      const data = await resp.json();
      if (data.success) {
        setItems(data.data.items);
      } else {
        toast({ title: '加载失败', description: data.error, variant: 'destructive' });
      }
    } catch (e: any) {
      toast({ title: '加载失败', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testCaseId, apiId, stepNodeId]);

  const updateStatus = async (id: string, status: 'acknowledged' | 'wontfix' | 'fixed') => {
    setActionLoading(id);
    try {
      const resp = await fetch(`/api/feedback/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      const data = await resp.json();
      if (data.success) {
        toast({
          title: status === 'acknowledged' ? '已采纳' : status === 'wontfix' ? '已标记误报' : '已修复',
          description: status === 'acknowledged' ? '此反馈将进入 AI 生成端的避坑清单' : undefined,
        });
        load();
      } else {
        toast({ title: '操作失败', description: data.error, variant: 'destructive' });
      }
    } catch (e: any) {
      toast({ title: '操作失败', description: e.message, variant: 'destructive' });
    } finally {
      setActionLoading(null);
    }
  };

  const handleAdd = async () => {
    if (!addSummary.trim()) {
      toast({ title: '请填写问题描述', variant: 'destructive' });
      return;
    }

    setAddLoading(true);
    try {
      const resp = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'user_comment',
          testCaseId,
          apiId,
          stepNodeId,
          category: addCategory,
          summary: addSummary,
          detail: addDetail || null,
        }),
      });
      const data = await resp.json();
      if (data.success) {
        toast({ title: '反馈已提交', description: '感谢你的反馈，评审通过后将帮助 AI 避坑' });
        setShowAddForm(false);
        setAddSummary('');
        setAddDetail('');
        setAddCategory('other');
        load();
      } else {
        toast({ title: '提交失败', description: data.error, variant: 'destructive' });
      }
    } catch (e: any) {
      toast({ title: '提交失败', description: e.message, variant: 'destructive' });
    } finally {
      setAddLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{title}</h3>
        {!showAddForm && (
          <Button size="sm" variant="outline" onClick={() => setShowAddForm(true)}>
            <Plus className="w-3 h-3 mr-1" />
            我觉得这里有问题
          </Button>
        )}
      </div>

      {/* 主动反馈表单 */}
      {showAddForm && (
        <div className="p-3 rounded-md border bg-muted/30 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">主动反馈</span>
            <Button size="sm" variant="ghost" onClick={() => setShowAddForm(false)}>
              取消
            </Button>
          </div>
          <Select value={addCategory} onValueChange={setAddCategory}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(CATEGORY_LABELS).map(([key, val]) => (
                <SelectItem key={key} value={key}>{val.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Textarea
            placeholder="一句话描述问题（如：这个断言期望值应该是 0 而不是 200）"
            value={addSummary}
            onChange={(e) => setAddSummary(e.target.value)}
            className="text-xs min-h-[60px]"
          />
          <Textarea
            placeholder="详细说明（选填）"
            value={addDetail}
            onChange={(e) => setAddDetail(e.target.value)}
            className="text-xs min-h-[60px]"
          />
          <Button size="sm" onClick={handleAdd} disabled={addLoading}>
            {addLoading && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
            提交反馈
          </Button>
        </div>
      )}

      {/* 反馈列表 */}
      {loading ? (
        <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          加载中...
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-8">
          <AlertCircle className="w-8 h-8 mx-auto text-muted-foreground/50 mb-2" />
          <div className="text-xs text-muted-foreground">暂无反馈</div>
          {!showAddForm && (
            <Button size="sm" variant="ghost" className="mt-2" onClick={() => setShowAddForm(true)}>
              <Plus className="w-3 h-3 mr-1" />
              我觉得这里有问题
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => {
            const categoryMeta = CATEGORY_LABELS[item.category] || CATEGORY_LABELS.other;
            const statusMeta = STATUS_LABELS[item.status] || STATUS_LABELS.open;
            return (
              <div key={item.id} className="p-3 rounded-md border text-xs space-y-2 hover:bg-muted/20 transition-colors">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 space-y-1.5">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <Badge className={`${categoryMeta.color} text-[10px] px-1.5 py-0`}>
                        {categoryMeta.label}
                      </Badge>
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                        {SOURCE_LABELS[item.source] || item.source}
                      </Badge>
                      <Badge className={`${statusMeta.color} text-[10px] px-1.5 py-0`}>
                        {statusMeta.label}
                      </Badge>
                      {item.consumedCount > 0 && (
                        <span className="text-[10px] text-muted-foreground">
                          被 AI 采纳 {item.consumedCount} 次
                        </span>
                      )}
                    </div>
                    <div className="font-medium">{item.summary}</div>
                    {item.detail && (
                      <div className="text-muted-foreground whitespace-pre-wrap">{item.detail}</div>
                    )}
                    {item.suggestion && (
                      <div className="p-1.5 rounded bg-emerald-50 border border-emerald-100 text-emerald-700">
                        <strong className="text-[10px]">建议：</strong>
                        {item.suggestion}
                      </div>
                    )}
                  </div>

                  {item.status === 'open' && (
                    <div className="flex flex-col gap-1 flex-shrink-0">
                      <Button
                        size="sm"
                        className="h-6 px-2 text-[10px]"
                        disabled={actionLoading === item.id}
                        onClick={() => updateStatus(item.id, 'acknowledged')}
                      >
                        <CheckCircle2 className="w-3 h-3 mr-0.5" />
                        采纳
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-[10px]"
                        disabled={actionLoading === item.id}
                        onClick={() => updateStatus(item.id, 'wontfix')}
                      >
                        <XCircle className="w-3 h-3 mr-0.5" />
                        误报
                      </Button>
                    </div>
                  )}
                  {item.status === 'acknowledged' && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[10px]"
                      disabled={actionLoading === item.id}
                      onClick={() => updateStatus(item.id, 'fixed')}
                    >
                      标记修复
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

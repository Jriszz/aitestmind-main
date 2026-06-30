"use client";

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CheckCircle2, XCircle, Loader2, MessageSquare, Sparkles } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

/**
 * 反馈评审页（/feedback）
 *
 * 设计要点：
 *   - 默认筛 status=open（待评审），让评审人聚焦没处理的
 *   - 每条可改 acknowledged（→ 进入 AI 避坑清单）/ wontfix（误报）
 *   - 只有 acknowledged 的反馈会被 query_api_feedback 工具返回给 AI 生成端
 *
 * 与执行详情页的「AI 归因」按钮形成完整闭环：
 *   失败 → 归因 → 评审 → 反喂生成
 */

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

export default function FeedbackPage() {
  const { toast } = useToast();
  const [items, setItems] = useState<Feedback[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('open');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (categoryFilter !== 'all') params.set('category', categoryFilter);
      params.set('pageSize', '50');

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
  }, [statusFilter, categoryFilter]);

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

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <MessageSquare className="w-6 h-6 text-amber-600" />
            反馈评审
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            评审 AI 归因与用户反馈，已采纳的反馈会反喂 smart-generate / explore-generate 作为避坑提示
          </p>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">状态</span>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部</SelectItem>
                  <SelectItem value="open">待评审</SelectItem>
                  <SelectItem value="acknowledged">已采纳</SelectItem>
                  <SelectItem value="fixed">已修复</SelectItem>
                  <SelectItem value="wontfix">误报</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">分类</span>
              <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部</SelectItem>
                  {Object.entries(CATEGORY_LABELS).map(([key, val]) => (
                    <SelectItem key={key} value={key}>{val.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="ml-auto text-sm text-muted-foreground">
              共 {items.length} 条
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="w-5 h-5 mr-2 animate-spin" />
              加载中...
            </div>
          ) : items.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              暂无符合条件的反馈
            </div>
          ) : (
            <div className="space-y-3">
              {items.map((item) => {
                const categoryMeta = CATEGORY_LABELS[item.category] || CATEGORY_LABELS.other;
                const statusMeta = STATUS_LABELS[item.status] || STATUS_LABELS.open;
                return (
                  <div key={item.id} className="border rounded-lg p-4 space-y-2 hover:bg-muted/30 transition-colors">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 space-y-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge className={categoryMeta.color}>{categoryMeta.label}</Badge>
                          <Badge variant="outline">{SOURCE_LABELS[item.source] || item.source}</Badge>
                          <Badge className={statusMeta.color}>{statusMeta.label}</Badge>
                          {item.consumedCount > 0 && (
                            <Badge variant="outline" className="text-xs">
                              <Sparkles className="w-3 h-3 mr-1" />
                              被 AI 采纳 {item.consumedCount} 次
                            </Badge>
                          )}
                        </div>

                        <div className="font-medium">{item.summary}</div>

                        {(item.api || item.testCase) && (
                          <div className="text-xs text-muted-foreground space-x-3">
                            {item.api && (
                              <span>
                                接口: {item.api.method} {item.api.path}
                              </span>
                            )}
                            {item.testCase && <span>用例: {item.testCase.name}</span>}
                            {item.targetField && <span>字段: {item.targetField}</span>}
                          </div>
                        )}

                        {item.detail && (
                          <div className="text-sm text-muted-foreground whitespace-pre-wrap">{item.detail}</div>
                        )}

                        {item.suggestion && (
                          <div className="text-sm p-2 rounded bg-emerald-50 border border-emerald-100 text-emerald-700">
                            <strong>建议：</strong>
                            {item.suggestion}
                          </div>
                        )}
                      </div>

                      {item.status === 'open' && (
                        <div className="flex flex-col gap-1 flex-shrink-0">
                          <Button
                            size="sm"
                            disabled={actionLoading === item.id}
                            onClick={() => updateStatus(item.id, 'acknowledged')}
                          >
                            <CheckCircle2 className="w-4 h-4 mr-1" />
                            采纳
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={actionLoading === item.id}
                            onClick={() => updateStatus(item.id, 'wontfix')}
                          >
                            <XCircle className="w-4 h-4 mr-1" />
                            误报
                          </Button>
                        </div>
                      )}
                      {item.status === 'acknowledged' && (
                        <Button
                          size="sm"
                          variant="outline"
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
        </CardContent>
      </Card>
    </div>
  );
}

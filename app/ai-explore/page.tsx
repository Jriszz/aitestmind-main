'use client';

import { useState, useEffect, useMemo } from 'react';
import { Telescope, Sparkles, Search, CheckSquare, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { FourLayerTree } from '@/components/api-repository/FourLayerTree';
import { ExploreGenerateDialog } from '@/components/api-repository/ExploreGenerateDialog';
import { useToast } from '@/hooks/use-toast';

const METHOD_COLORS: Record<string, string> = {
  GET: 'bg-green-500',
  POST: 'bg-blue-500',
  PUT: 'bg-orange-500',
  DELETE: 'bg-red-500',
  PATCH: 'bg-purple-500',
};

/**
 * AI 探索（独立入口）
 * 定位：用户给"范围"（按分类圈 / 勾选零散一组），AI 自主探索接口、设计场景、生成用例。
 * 与 AI 生成（会话式、人描述场景）对称、互补。
 * 复用 API 仓库的分类树 + ExploreGenerateDialog，不寄生在仓库 tab 里。
 */
export default function AIExplorePage() {
  const { toast } = useToast();
  const [allApis, setAllApis] = useState<any[]>([]);
  const [classifications, setClassifications] = useState<any[]>([]);
  const [filter, setFilter] = useState<{
    platform?: string;
    component?: string;
    feature?: string;
    subFeature?: string;
    isStarred?: boolean;
  }>({});
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [exploreIds, setExploreIds] = useState<string[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const [apisRes, clsRes] = await Promise.all([
          fetch('/api/api-library/list?page=1&pageSize=10000').then((r) => r.json()),
          fetch('/api/api-library/classifications').then((r) => r.json()),
        ]);
        if (apisRes.success) setAllApis(apisRes.data || []);
        if (clsRes.success) setClassifications(clsRes.data || []);
      } catch {
        toast({ title: '加载失败', description: '无法加载接口列表', variant: 'destructive' });
      }
    })();
  }, [toast]);

  // 按分类筛选 + 搜索后的可见接口
  const visibleApis = useMemo(() => {
    const match = (apiVal: string | null | undefined, f?: string) => {
      if (f === undefined) return true;
      if (f === '__NULL__') return !apiVal;
      return apiVal === f;
    };
    return allApis.filter((api) => {
      const scopeOk =
        match(api.platform, filter.platform) &&
        match(api.component, filter.component) &&
        match(api.feature, filter.feature) &&
        match(api.subFeature, filter.subFeature) &&
        (!filter.isStarred || api.isStarred);
      const searchOk =
        !search ||
        api.name?.toLowerCase().includes(search.toLowerCase()) ||
        api.path?.toLowerCase().includes(search.toLowerCase());
      return scopeOk && searchOk;
    });
  }, [allApis, filter, search]);

  const hasScope = !!(
    filter.platform || filter.component || filter.feature || filter.subFeature || filter.isStarred
  );

  const toggle = (id: string) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  const toggleAllVisible = () => {
    const visibleIds = visibleApis.map((a) => a.id);
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
    setSelected(allSelected ? new Set() : new Set(visibleIds));
  };

  // 探索范围：优先用勾选的；没勾选则用当前筛选范围全部
  const openExplore = (ids: string[]) => {
    if (ids.length === 0) return;
    setExploreIds(ids);
    setDialogOpen(true);
  };

  return (
    <div className="h-full flex bg-background">
      {/* 左侧：分类树（圈选业务模块） */}
      <div className="w-72 h-full shrink-0">
        <FourLayerTree
          apis={allApis}
          classifications={classifications}
          selectedFilter={filter}
          onFilterChange={(f) => {
            setFilter(f);
            setSelected(new Set()); // 切范围时清空勾选
          }}
        />
      </div>

      {/* 右侧：接口列表 + 探索入口 */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* 头部 */}
        <div className="p-4 border-b border-[#e5e7eb] dark:border-[#4b5563] space-y-3">
          <div className="flex items-center gap-2">
            <Telescope className="h-5 w-5 text-fuchsia-600" />
            <h2 className="text-lg font-semibold">AI 探索</h2>
            <span className="text-sm text-muted-foreground">
              给 AI 一个范围，它自主探索接口、设计场景、生成用例——你只需挑选，无需描述场景。
            </span>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索接口名称 / 路径"
                className="pl-9 h-9"
              />
            </div>

            <Button onClick={toggleAllVisible} variant="outline" size="sm" className="h-9">
              {visibleApis.length > 0 && visibleApis.every((a) => selected.has(a.id)) ? (
                <><CheckSquare className="mr-1.5 h-4 w-4" />取消全选</>
              ) : (
                <><Square className="mr-1.5 h-4 w-4" />全选当前</>
              )}
            </Button>

            {/* 主入口：勾了就探索勾选的（零散一组）；没勾且有分类范围则探索该模块 */}
            {selected.size > 0 ? (
              <Button onClick={() => openExplore(Array.from(selected))} size="sm" className="h-9">
                <Sparkles className="mr-1.5 h-4 w-4" />
                AI 探索生成（{selected.size}）
              </Button>
            ) : hasScope ? (
              <Button
                onClick={() => openExplore(visibleApis.map((a) => a.id))}
                size="sm"
                className="h-9"
                title="对当前筛选范围内的全部接口探索生成"
              >
                <Sparkles className="mr-1.5 h-4 w-4" />
                探索该模块（{visibleApis.length}）
              </Button>
            ) : (
              <Button size="sm" className="h-9" disabled title="请先在左侧选择一个分类，或勾选接口">
                <Sparkles className="mr-1.5 h-4 w-4" />
                AI 探索生成
              </Button>
            )}
          </div>

          {!hasScope && selected.size === 0 && (
            <p className="text-xs text-muted-foreground">
              提示：在左侧选一个业务模块（测整个模块），或在下方勾选若干接口（测跨模块的零散一组）。
            </p>
          )}
        </div>

        {/* 接口列表 */}
        <div className="flex-1 overflow-y-auto p-4 space-y-1.5">
          {visibleApis.length === 0 ? (
            <div className="text-center py-16 text-sm text-muted-foreground">
              {allApis.length === 0 ? '接口库为空' : '该范围下没有接口'}
            </div>
          ) : (
            visibleApis.map((api) => (
              <div
                key={api.id}
                className={`flex items-center gap-3 border rounded-lg px-3 py-2 cursor-pointer transition-colors ${
                  selected.has(api.id) ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'
                }`}
                onClick={() => toggle(api.id)}
              >
                <Checkbox checked={selected.has(api.id)} onCheckedChange={() => toggle(api.id)} />
                <Badge className={`${METHOD_COLORS[api.method] || 'bg-gray-500'} text-white text-xs shrink-0`}>
                  {api.method}
                </Badge>
                <span className="font-medium text-sm truncate">{api.name}</span>
                <span className="text-xs text-muted-foreground font-mono truncate ml-auto">{api.path}</span>
              </div>
            ))
          )}
        </div>
      </div>

      <ExploreGenerateDialog
        apiIds={exploreIds}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onGenerated={() => setSelected(new Set())}
      />
    </div>
  );
}

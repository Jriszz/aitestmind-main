'use client';

import { useState } from 'react';
import { Telescope } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FunctionalCasePanel } from '@/components/ai-explore/FunctionalCasePanel';
import { ChainExplorePanel } from '@/components/ai-explore/ChainExplorePanel';

/**
 * AI 探索（独立入口）
 * 定位：从业务意图出发。两种入口：
 *  - 从需求文档：粘贴需求/功能规格 → AI 设计接口功能用例。
 *  - 从主干链路：人梳理主干骨架 → AI 沿链发散跨服务异常/对账/边界用例（微服务场景）。
 * 两者产物都进"接口功能用例"库，再探索 API 生成待编排。与 AI 生成（会话式）对称、互补。
 *
 * 说明：原"从接口范围"（圈接口让 AI 反推场景）已下线——从接口清单出发，与"从业务意图出发"
 * 的主线相悖。接口匹配交由下游 explore-generate 自动检索完成。
 */
export function AIExplorePageImpl() {
  const [mode, setMode] = useState<'doc' | 'chain'>('doc');

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-[#e5e7eb] dark:border-[#4b5563]">
        <Telescope className="h-5 w-5 text-fuchsia-600 shrink-0" />
        <h1 className="text-base font-semibold shrink-0">AI 探索</h1>
        <Tabs value={mode} onValueChange={(v) => setMode(v as 'doc' | 'chain')}>
          <TabsList className="h-8">
            <TabsTrigger value="doc" className="text-xs px-3">从需求文档</TabsTrigger>
            <TabsTrigger value="chain" className="text-xs px-3">从主干链路</TabsTrigger>
          </TabsList>
        </Tabs>
        <span className="text-xs text-muted-foreground ml-1 hidden md:inline">
          {mode === 'doc'
            ? '粘贴需求/功能规格，AI 生成接口功能用例（可编辑），再探索 API 生成待编排。'
            : '梳理主干链路，AI 沿链发散跨服务异常/对账/边界用例（适合微服务）。'}
        </span>
      </div>

      <div className="flex-1 min-h-0 flex">
        {mode === 'doc' ? <FunctionalCasePanel /> : <ChainExplorePanel />}
      </div>
    </div>
  );
}

/**
 * 路由出口占位：真实实例由 TabManager 常驻挂载（keep-alive），此处返回空避免双挂载。
 * 见 components/tabs/TabManager.tsx。
 */
export default function AIExplorePage() {
  return null;
}


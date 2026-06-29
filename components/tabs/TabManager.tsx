"use client"

import { useTabs } from "@/contexts/tabs-context"
import { TabBar } from "./TabBar"
import { Activity, ComponentType, ReactNode } from "react"
import { AIExplorePageImpl } from "@/app/ai-explore/page"
import { AIGeneratePageImpl } from "@/app/ai-generate/page"

interface TabManagerProps {
  children: ReactNode
}

// 真实 keep-alive 的页面：组件实例由 TabManager 常驻持有，用 Activity 切显隐。
// 这些路径的 route 文件 default export 返回 null（占位），实例只在这里挂载，避免双挂载。
const KEEP_ALIVE: Record<string, ComponentType> = {
  '/ai-explore': AIExplorePageImpl,
  '/ai-generate': AIGeneratePageImpl,
}

export function TabManager({ children }: TabManagerProps) {
  const { tabs, activeTabId } = useTabs()

  // 所有页面内容区域都允许纵向滚动
  const contentOverflow = 'overflow-auto scrollbar-hide'

  const activeTab = activeTabId ? tabs.find(tab => tab.id === activeTabId) : null
  // 当前活跃页是否为 keep-alive 页（其实例来自下方 Activity，路由 children 是空占位，不渲染）
  const activeIsKeepAlive = !!activeTab && activeTab.path in KEEP_ALIVE

  // 当前打开的、命中 keep-alive 注册表的路径（去重）。组件常驻挂载，关闭即从列表移除 → 卸载销毁。
  const keepAlivePaths = Array.from(
    new Set(tabs.map(tab => tab.path).filter(path => path in KEEP_ALIVE))
  )

  return (
    <div className="flex flex-col h-full">
      <TabBar />
      <div className="flex-1 overflow-hidden relative">
        {/* keep-alive 页：组件实例常驻，仅切换可见性，state/进行中请求不丢。
            key 用 path —— 同一路径全局唯一实例；tab 关闭后 path 从列表移除即卸载，重开是全新实例。 */}
        {keepAlivePaths.map(path => {
          const Comp = KEEP_ALIVE[path]
          const isActive = !!activeTab && activeTab.path === path
          return (
            <Activity key={path} mode={isActive ? 'visible' : 'hidden'}>
              <div className={`absolute inset-0 h-full ${contentOverflow}`}>
                <Comp />
              </div>
            </Activity>
          )
        })}

        {/* 非 keep-alive 当前页（或无标签）：沿用路由 children，切走即卸载。
            active 为 keep-alive 页时不渲染 children（此时 children 是空占位，避免重复）。 */}
        {!activeIsKeepAlive && (
          <div className={`absolute inset-0 h-full ${contentOverflow}`}>
            {children}
          </div>
        )}
      </div>
    </div>
  )
}

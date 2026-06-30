"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Check, ChevronsUpDown, FolderKanban, Settings2 } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

interface Workspace {
  id: string
  name: string
  slug: string
  isDefault: boolean
}

interface WorkspaceSwitcherProps {
  isCollapsed?: boolean
}

/**
 * 工作区切换器（资产管理总线 Step 1）
 * - 挂在 sidebar 顶部，作为资产视图的归属边界入口
 * - 切换后 window.location.reload() 让所有 SSR 数据按新 workspaceId 重取
 * - 详见 docs/DESIGN_DECISIONS.md 决策 10
 */
export function WorkspaceSwitcher({ isCollapsed = false }: WorkspaceSwitcherProps) {
  const router = useRouter()
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [switching, setSwitching] = useState(false)

  useEffect(() => {
    let alive = true
    fetch("/api/workspaces")
      .then((r) => r.json())
      .then((data) => {
        if (!alive) return
        if (data.success) {
          setWorkspaces(data.workspaces || [])
          setCurrentId(data.currentWorkspaceId || null)
        }
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const current = workspaces.find((w) => w.id === currentId)
  const currentName = current?.name ?? "加载中…"

  const handleSwitch = async (workspaceId: string) => {
    if (workspaceId === currentId || switching) return
    setSwitching(true)
    try {
      const res = await fetch("/api/workspaces/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      })
      const data = await res.json()
      if (data.success) {
        // 强制刷新整个页面，确保所有 SSR/客户端缓存按新 workspaceId 重取
        window.location.reload()
      } else {
        setSwitching(false)
      }
    } catch {
      setSwitching(false)
    }
  }

  if (loading) {
    return (
      <div
        className={cn(
          "flex items-center text-sm text-muted-foreground",
          isCollapsed ? "justify-center" : "px-2"
        )}
      >
        <FolderKanban className="h-4 w-4 opacity-50" />
        {!isCollapsed && <span className="ml-2">加载中…</span>}
      </div>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "w-full justify-between gap-2",
            isCollapsed && "px-0 justify-center"
          )}
          title={isCollapsed ? `当前工作区：${currentName}` : undefined}
        >
          <span className="flex items-center gap-2 truncate">
            <FolderKanban className="h-4 w-4 flex-shrink-0 text-purple-600" />
            {!isCollapsed && <span className="truncate">{currentName}</span>}
          </span>
          {!isCollapsed && <ChevronsUpDown className="h-4 w-4 flex-shrink-0 opacity-50" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel>切换工作区</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {workspaces.length === 0 ? (
          <div className="px-2 py-3 text-sm text-muted-foreground">
            暂无工作区
          </div>
        ) : (
          workspaces.map((ws) => (
            <DropdownMenuItem
              key={ws.id}
              onClick={() => handleSwitch(ws.id)}
              disabled={switching}
              className="flex items-center justify-between gap-2"
            >
              <span className="flex items-center gap-2 truncate">
                <span className="truncate">{ws.name}</span>
                {ws.isDefault && (
                  <Badge variant="secondary" className="text-[10px] px-1 py-0">
                    默认
                  </Badge>
                )}
              </span>
              {ws.id === currentId && <Check className="h-4 w-4 text-purple-600" />}
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => router.push("/workspaces")}
          className="text-sm"
        >
          <Settings2 className="h-4 w-4 mr-2" />
          管理工作区
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

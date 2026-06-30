"use client"

import { useEffect, useState, useCallback } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/hooks/use-toast"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Plus,
  Globe,
  RefreshCw,
  Pencil,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  MinusCircle,
  Clock,
} from "lucide-react"
import { SwaggerSourceDialog, type SwaggerSourceFormValue } from "./SwaggerSourceDialog"

interface SwaggerSource {
  id: string
  name: string
  url: string
  defaultPlatform: string | null
  defaultComponent: string | null
  defaultFeature: string | null
  lastSyncAt: string | null
  lastSyncStatus: string | null
  lastSyncMessage: string | null
  totalApiCount: number
  lastImportedCount: number
  createdAt: string
  updatedAt: string
}

interface SwaggerSourcesPanelProps {
  /** 同步成功后通知父组件刷新接口列表 */
  onApisChanged?: () => void
}

/**
 * Swagger 数据源管理面板
 * 资产管理总线 Step 2 的 UI 主入口
 * - 列出当前工作区下的所有 Swagger 数据源
 * - 支持新建、编辑、删除、一键重新同步
 */
export function SwaggerSourcesPanel({ onApisChanged }: SwaggerSourcesPanelProps) {
  const { toast } = useToast()

  const [sources, setSources] = useState<SwaggerSource[]>([])
  const [loading, setLoading] = useState(true)
  const [syncingId, setSyncingId] = useState<string | null>(null)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<SwaggerSourceFormValue | null>(null)

  const [deleteTarget, setDeleteTarget] = useState<SwaggerSource | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/swagger-sources")
      const data = await res.json()
      if (data.success) {
        setSources(data.sources || [])
      } else {
        toast({ title: data.error || "加载失败", variant: "destructive" })
      }
    } catch (err: any) {
      toast({ title: err?.message || "加载失败", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    load()
  }, [load])

  const handleSync = async (id: string) => {
    if (syncingId) return
    setSyncingId(id)
    try {
      const res = await fetch(`/api/swagger-sources/${id}/sync`, { method: "POST" })
      const data = await res.json()
      if (data.success) {
        if (data.skipped) {
          toast({ title: "未发现变化", description: data.reason || "内容未变更" })
        } else {
          const parts = [
            data.created > 0 && `新增 ${data.created}`,
            data.updated > 0 && `更新 ${data.updated}`,
            data.failed > 0 && `失败 ${data.failed}`,
          ].filter(Boolean)
          toast({
            title: "同步完成",
            description: parts.length > 0 ? parts.join(" / ") : "无变化",
            variant: data.failed > 0 ? "destructive" : "default",
          })
          if (data.created > 0 || data.updated > 0) {
            onApisChanged?.()
          }
        }
      } else {
        toast({ title: "同步失败", description: data.error || "未知错误", variant: "destructive" })
      }
      await load() // 刷新源卡片状态
    } catch (err: any) {
      toast({ title: "同步失败", description: err?.message, variant: "destructive" })
    } finally {
      setSyncingId(null)
    }
  }

  const handleEdit = (source: SwaggerSource) => {
    setEditTarget({
      id: source.id,
      name: source.name,
      url: source.url,
      authHeadersText: "", // 出于安全考虑不回显已存的认证头，留空表示"不修改"
      defaultPlatform: source.defaultPlatform || undefined,
      defaultComponent: source.defaultComponent || undefined,
      defaultFeature: source.defaultFeature || undefined,
    })
    setDialogOpen(true)
  }

  const handleNew = () => {
    setEditTarget(null)
    setDialogOpen(true)
  }

  const handleSaved = async (sourceId: string, syncImmediately: boolean) => {
    await load()
    if (syncImmediately) {
      await handleSync(sourceId)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    try {
      const res = await fetch(`/api/swagger-sources/${deleteTarget.id}`, { method: "DELETE" })
      const data = await res.json()
      if (data.success) {
        toast({ title: "数据源已删除", description: "已落库的接口未受影响" })
        setDeleteTarget(null)
        await load()
      } else {
        toast({ title: data.error || "删除失败", variant: "destructive" })
      }
    } catch (err: any) {
      toast({ title: err?.message || "删除失败", variant: "destructive" })
    }
  }

  const renderStatusBadge = (status: string | null) => {
    if (!status) return null
    const config: Record<string, { icon: any; className: string; label: string }> = {
      success: {
        icon: CheckCircle2,
        className: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
        label: "成功",
      },
      partial: {
        icon: AlertTriangle,
        className: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
        label: "部分成功",
      },
      failed: {
        icon: XCircle,
        className: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
        label: "失败",
      },
      skipped: {
        icon: MinusCircle,
        className: "bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-300",
        label: "未变化",
      },
    }
    const c = config[status] ?? config.failed
    const Icon = c.icon
    return (
      <span
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${c.className}`}
      >
        <Icon className="h-3 w-3" />
        {c.label}
      </span>
    )
  }

  const formatTime = (iso: string | null) => {
    if (!iso) return "—"
    const d = new Date(iso)
    const now = Date.now()
    const diff = now - d.getTime()
    if (diff < 60_000) return "刚刚"
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`
    return d.toLocaleString("zh-CN", { hour12: false })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Swagger 数据源</h3>
          <p className="text-sm text-muted-foreground mt-0.5">
            留底 URL，后续可一键重新同步。已落库的接口走字段级合并 + 业务语义双层。
          </p>
        </div>
        <Button onClick={handleNew}>
          <Plus className="h-4 w-4 mr-2" />
          新建数据源
        </Button>
      </div>

      {loading ? (
        <div className="text-muted-foreground text-sm py-8 text-center">加载中…</div>
      ) : sources.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Globe className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p className="text-sm">当前工作区还没有 Swagger 数据源</p>
            <p className="text-xs mt-1">点击右上「新建数据源」开始</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {sources.map((source) => {
            const isSyncing = syncingId === source.id
            const classificationPath = [source.defaultPlatform, source.defaultComponent, source.defaultFeature]
              .filter(Boolean)
              .join(" > ")
            return (
              <Card key={source.id} className="flex flex-col">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-base truncate" title={source.name}>
                      {source.name}
                    </CardTitle>
                    <div className="flex gap-1 flex-shrink-0">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => handleEdit(source)}
                        disabled={isSyncing}
                        title="编辑"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-red-500 hover:text-red-600"
                        onClick={() => setDeleteTarget(source)}
                        disabled={isSyncing}
                        title="删除"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="text-sm space-y-2 flex-1 flex flex-col">
                  <div className="flex items-center gap-1.5 text-muted-foreground text-xs truncate" title={source.url}>
                    <Globe className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="truncate">{source.url}</span>
                  </div>

                  {classificationPath && (
                    <div className="text-xs">
                      <span className="text-muted-foreground">默认分类：</span>
                      <span>{classificationPath}</span>
                    </div>
                  )}

                  <div className="text-xs flex items-center gap-2">
                    <span className="text-muted-foreground">已同步：</span>
                    <span className="font-medium">{source.totalApiCount}</span>
                    <span className="text-muted-foreground">个接口</span>
                  </div>

                  <div className="text-xs flex items-center gap-2 flex-wrap">
                    <Clock className="h-3 w-3 text-muted-foreground" />
                    <span className="text-muted-foreground">{formatTime(source.lastSyncAt)}</span>
                    {renderStatusBadge(source.lastSyncStatus)}
                  </div>

                  {source.lastSyncMessage && (
                    <div className="text-xs text-muted-foreground italic line-clamp-2" title={source.lastSyncMessage}>
                      {source.lastSyncMessage}
                    </div>
                  )}

                  <div className="flex-1" />
                  <Button
                    onClick={() => handleSync(source.id)}
                    disabled={isSyncing || syncingId !== null}
                    className="w-full mt-2"
                    size="sm"
                  >
                    <RefreshCw className={`h-4 w-4 mr-2 ${isSyncing ? "animate-spin" : ""}`} />
                    {isSyncing ? "同步中…" : "立即同步"}
                  </Button>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      <SwaggerSourceDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initial={editTarget}
        onSaved={handleSaved}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除 Swagger 数据源</AlertDialogTitle>
            <AlertDialogDescription>
              确认删除「{deleteTarget?.name}」吗？已落库的接口不会被删除——它们是独立资产。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-red-600 hover:bg-red-700">
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
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
import { FolderKanban, Plus, Pencil, Trash2, AlertTriangle } from "lucide-react"
import { useToast } from "@/hooks/use-toast"

interface WorkspaceItem {
  id: string
  name: string
  slug: string
  description: string | null
  isDefault: boolean
  createdAt: string
  _count: {
    apis: number
    testCases: number
    testSuites: number
    interfaceFunctionalCases: number
    conversations: number
  }
}

export default function WorkspacesPage() {
  const { toast } = useToast()
  const [workspaces, setWorkspaces] = useState<WorkspaceItem[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const [createOpen, setCreateOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<WorkspaceItem | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceItem | null>(null)
  const [deleteCounts, setDeleteCounts] = useState<{ [k: string]: number } | null>(null)
  const [forceDelete, setForceDelete] = useState(false)

  const [formName, setFormName] = useState("")
  const [formSlug, setFormSlug] = useState("")
  const [formDesc, setFormDesc] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/workspaces")
      const data = await res.json()
      if (data.success) {
        setWorkspaces(data.workspaces || [])
        setCurrentId(data.currentWorkspaceId || null)
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const openCreate = () => {
    setFormName("")
    setFormSlug("")
    setFormDesc("")
    setCreateOpen(true)
  }

  const openEdit = (ws: WorkspaceItem) => {
    setEditTarget(ws)
    setFormName(ws.name)
    setFormSlug(ws.slug)
    setFormDesc(ws.description || "")
    setEditOpen(true)
  }

  const openDelete = (ws: WorkspaceItem) => {
    setDeleteTarget(ws)
    setDeleteCounts(ws._count as any)
    setForceDelete(false)
    setDeleteOpen(true)
  }

  const submitCreate = async () => {
    setSubmitting(true)
    try {
      const res = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formName,
          slug: formSlug || undefined,
          description: formDesc,
        }),
      })
      const data = await res.json()
      if (data.success) {
        toast({ title: "工作区创建成功" })
        setCreateOpen(false)
        await load()
      } else {
        toast({ title: data.error || "创建失败", variant: "destructive" })
      }
    } finally {
      setSubmitting(false)
    }
  }

  const submitEdit = async () => {
    if (!editTarget) return
    setSubmitting(true)
    try {
      const res = await fetch(`/api/workspaces/${editTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formName,
          slug: formSlug,
          description: formDesc,
        }),
      })
      const data = await res.json()
      if (data.success) {
        toast({ title: "工作区已更新" })
        setEditOpen(false)
        await load()
      } else {
        toast({ title: data.error || "更新失败", variant: "destructive" })
      }
    } finally {
      setSubmitting(false)
    }
  }

  const submitDelete = async () => {
    if (!deleteTarget) return
    setSubmitting(true)
    try {
      const url = forceDelete
        ? `/api/workspaces/${deleteTarget.id}?force=true`
        : `/api/workspaces/${deleteTarget.id}`
      const res = await fetch(url, { method: "DELETE" })
      const data = await res.json()
      if (data.success) {
        toast({ title: "工作区已删除" })
        setDeleteOpen(false)
        await load()
      } else if (res.status === 409 && data.counts) {
        setDeleteCounts(data.counts)
        toast({ title: "工作区下还有资产，请勾选强制删除后再试", variant: "destructive" })
      } else {
        toast({ title: data.error || "删除失败", variant: "destructive" })
      }
    } finally {
      setSubmitting(false)
    }
  }

  const totalAssets = (c: WorkspaceItem["_count"]) =>
    c.apis + c.testCases + c.testSuites + c.interfaceFunctionalCases + c.conversations

  return (
    <div className="container mx-auto py-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FolderKanban className="h-6 w-6 text-purple-600" />
            工作区管理
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            工作区是资产（API/用例/套件/对话）的归属边界，也是 AI 上下文边界。切换工作区后，列表与 AI 仅看到当前工作区数据。
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4 mr-2" />
          新建工作区
        </Button>
      </div>

      {loading ? (
        <div className="text-muted-foreground">加载中…</div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {workspaces.map((ws) => (
            <Card key={ws.id} className={ws.id === currentId ? "border-purple-500" : undefined}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="text-base flex items-center gap-2">
                      {ws.name}
                      {ws.isDefault && <Badge variant="secondary">默认</Badge>}
                      {ws.id === currentId && <Badge>当前</Badge>}
                    </CardTitle>
                    <p className="text-xs text-muted-foreground mt-1">slug: {ws.slug}</p>
                  </div>
                  <div className="flex gap-1">
                    <Button size="icon" variant="ghost" onClick={() => openEdit(ws)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      disabled={ws.isDefault}
                      onClick={() => openDelete(ws)}
                    >
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="text-sm space-y-2">
                {ws.description && (
                  <p className="text-muted-foreground">{ws.description}</p>
                )}
                <div className="grid grid-cols-2 gap-1 text-xs">
                  <div>API：{ws._count.apis}</div>
                  <div>用例：{ws._count.testCases}</div>
                  <div>套件：{ws._count.testSuites}</div>
                  <div>功能用例：{ws._count.interfaceFunctionalCases}</div>
                  <div>对话：{ws._count.conversations}</div>
                  <div className="font-medium text-purple-600">
                    总计：{totalAssets(ws._count)}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* 创建对话框 */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建工作区</DialogTitle>
            <DialogDescription>创建新的工作区来归属一组项目的资产</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-2">
              <Label>名称</Label>
              <Input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="如：订单服务测试"
              />
            </div>
            <div className="space-y-2">
              <Label>Slug（可选，自动生成）</Label>
              <Input
                value={formSlug}
                onChange={(e) => setFormSlug(e.target.value)}
                placeholder="如：order-service"
              />
            </div>
            <div className="space-y-2">
              <Label>描述（可选）</Label>
              <Textarea
                value={formDesc}
                onChange={(e) => setFormDesc(e.target.value)}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button onClick={submitCreate} disabled={submitting || !formName.trim()}>
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 编辑对话框 */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑工作区</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-2">
              <Label>名称</Label>
              <Input value={formName} onChange={(e) => setFormName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Slug</Label>
              <Input value={formSlug} onChange={(e) => setFormSlug(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>描述</Label>
              <Textarea
                value={formDesc}
                onChange={(e) => setFormDesc(e.target.value)}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              取消
            </Button>
            <Button onClick={submitEdit} disabled={submitting}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              删除工作区
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  确认删除工作区 <strong>{deleteTarget?.name}</strong> 吗？
                </p>
                {deleteCounts &&
                  Object.values(deleteCounts).some((v) => (v as number) > 0) && (
                    <div className="bg-amber-50 dark:bg-amber-900/20 p-3 rounded text-xs space-y-1">
                      <p className="font-medium text-amber-700 dark:text-amber-300">
                        当前工作区下还有以下资产，删除后这些资产将变为「无归属」：
                      </p>
                      <ul className="pl-4 space-y-0.5">
                        <li>API：{deleteCounts.apis}</li>
                        <li>用例：{deleteCounts.testCases}</li>
                        <li>套件：{deleteCounts.testSuites}</li>
                        <li>功能用例：{deleteCounts.interfaceFunctionalCases}</li>
                        <li>对话：{deleteCounts.conversations}</li>
                      </ul>
                      <label className="flex items-center gap-2 mt-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={forceDelete}
                          onChange={(e) => setForceDelete(e.target.checked)}
                        />
                        <span>我已知晓后果，强制删除</span>
                      </label>
                    </div>
                  )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={submitDelete}
              disabled={
                submitting ||
                (!!deleteCounts &&
                  Object.values(deleteCounts).some((v) => (v as number) > 0) &&
                  !forceDelete)
              }
              className="bg-red-600 hover:bg-red-700"
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

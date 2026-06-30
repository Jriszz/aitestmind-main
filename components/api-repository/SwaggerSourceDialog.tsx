"use client"

import { useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { FourLayerSelector } from "@/components/api-repository/FourLayerSelector"
import { Loader2, AlertCircle } from "lucide-react"

export interface SwaggerSourceFormValue {
  id?: string
  name: string
  url: string
  authHeadersText: string // 文本编辑：每行一对 Key: Value
  defaultPlatform?: string
  defaultComponent?: string
  defaultFeature?: string
}

interface SwaggerSourceDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** 编辑场景传入初值；新建场景留空 */
  initial?: SwaggerSourceFormValue | null
  /** 创建/编辑成功后回调（参数含本次保存后的源 id） */
  onSaved: (sourceId: string, syncImmediately: boolean) => void
}

/**
 * Swagger 数据源新建/编辑对话框
 * - 新建场景：展示「创建并立即同步」与「仅创建」两个按钮
 * - 编辑场景：仅展示「保存」按钮
 */
export function SwaggerSourceDialog({
  open,
  onOpenChange,
  initial,
  onSaved,
}: SwaggerSourceDialogProps) {
  const { toast } = useToast()
  const isEdit = !!initial?.id

  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [authHeadersText, setAuthHeadersText] = useState("")
  const [classification, setClassification] = useState<{
    platform?: string
    component?: string
    feature?: string
    subFeature?: string
  }>({})
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(initial?.name ?? "")
    setUrl(initial?.url ?? "")
    setAuthHeadersText(initial?.authHeadersText ?? "")
    setClassification({
      platform: initial?.defaultPlatform,
      component: initial?.defaultComponent,
      feature: initial?.defaultFeature,
    })
  }, [open, initial])

  // 解析 "Key: Value" 多行文本 → 对象
  // 容错：空行/无冒号行直接忽略；冒号后取剩余全部为值
  const parseAuthHeaders = (): { ok: true; value: Record<string, string> | null } | { ok: false; error: string } => {
    const trimmed = authHeadersText.trim()
    if (!trimmed) return { ok: true, value: null }
    const obj: Record<string, string> = {}
    for (const rawLine of trimmed.split("\n")) {
      const line = rawLine.trim()
      if (!line) continue
      const idx = line.indexOf(":")
      if (idx <= 0) {
        return { ok: false, error: `认证头格式错误，每行需要 "Key: Value"：${line}` }
      }
      const key = line.slice(0, idx).trim()
      const value = line.slice(idx + 1).trim()
      if (!key) {
        return { ok: false, error: `认证头 Key 不能为空：${line}` }
      }
      obj[key] = value
    }
    return { ok: true, value: Object.keys(obj).length > 0 ? obj : null }
  }

  const submit = async (syncImmediately: boolean) => {
    if (!name.trim()) {
      toast({ title: "请填写数据源名称", variant: "destructive" })
      return
    }
    if (!url.trim()) {
      toast({ title: "请填写 URL", variant: "destructive" })
      return
    }

    const headersResult = parseAuthHeaders()
    if (!headersResult.ok) {
      toast({ title: headersResult.error, variant: "destructive" })
      return
    }

    setSubmitting(true)
    try {
      const payload = {
        name: name.trim(),
        url: url.trim(),
        authHeaders: headersResult.value,
        defaultPlatform: classification.platform || null,
        defaultComponent: classification.component || null,
        defaultFeature: classification.feature || null,
      }

      const endpoint = isEdit ? `/api/swagger-sources/${initial!.id}` : "/api/swagger-sources"
      const method = isEdit ? "PATCH" : "POST"

      const res = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!data.success) {
        toast({ title: data.error || "保存失败", variant: "destructive" })
        setSubmitting(false)
        return
      }

      toast({ title: isEdit ? "数据源已更新" : "数据源已创建" })
      onOpenChange(false)
      onSaved(data.source.id, syncImmediately)
    } catch (err: any) {
      toast({ title: err?.message || "保存失败", variant: "destructive" })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "编辑 Swagger 数据源" : "新建 Swagger 数据源"}</DialogTitle>
          <DialogDescription>
            数据源会留底 URL，后续可一键重新同步——拉取、字段级合并、入库全自动。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>数据源名称</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：订单服务-test"
              disabled={submitting}
            />
          </div>

          <div className="space-y-2">
            <Label>Swagger / OpenAPI URL</Label>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/v3/api-docs"
              disabled={submitting}
            />
            <p className="text-xs text-muted-foreground">
              支持 Swagger 2.0 / OpenAPI 3.x 的 JSON 或 YAML。出于安全考虑默认禁止内网/本地地址。
            </p>
          </div>

          <div className="space-y-2">
            <Label>认证 Header（可选）</Label>
            <Textarea
              value={authHeadersText}
              onChange={(e) => setAuthHeadersText(e.target.value)}
              placeholder={"Authorization: Bearer xxx\nX-Api-Key: yyy"}
              rows={3}
              disabled={submitting}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              每行一对 <code>Key: Value</code>。仅在拉取文档时使用，明文存储——敏感凭据请慎重。
            </p>
          </div>

          <div className="space-y-2">
            <Label>默认四层分类（可选）</Label>
            <p className="text-xs text-muted-foreground">
              同步落库时，缺少分类的接口会填充以下默认值；接口自带 platform/component/feature 时不被覆盖。
            </p>
            <FourLayerSelector
              value={classification}
              onChange={setClassification}
              allowCreate
            />
          </div>

          {!isEdit && (
            <div className="flex gap-2 p-3 rounded-md bg-blue-50 dark:bg-blue-950/30 text-xs text-blue-900 dark:text-blue-100">
              <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <div>
                创建后会立即同步一次：拉取 → 解析 → 落库。已存在的接口会按字段级合并（决策 4），业务语义按
                baseline+override 双层写入（决策 5），不会自动覆盖你已确认的 override。
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          {isEdit ? (
            <Button onClick={() => submit(false)} disabled={submitting}>
              {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              保存
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => submit(false)} disabled={submitting}>
                {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                仅创建
              </Button>
              <Button onClick={() => submit(true)} disabled={submitting}>
                {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                创建并立即同步
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { FileCode2, Save, ChevronRight, CheckSquare, Square, Search, Filter, Upload, Link2 } from "lucide-react";
import { CapturedApi } from "@/types/har";
import { useToast } from "@/hooks/use-toast";
import { useTranslations } from "next-intl";
import { FourLayerSelector } from "@/components/api-repository/FourLayerSelector";
import {
  ApiConflictResolverDialog,
  type ApiConflict,
  type ConflictDecision,
} from "@/components/api-repository/ApiConflictResolverDialog";
import {
  SemanticReviewDialog,
  type SemanticReviewItem,
  type SemanticReviewDecision,
} from "@/components/api-capture/SemanticReviewDialog";
import { diffSemantics } from "@/lib/semantics-diff";

interface SwaggerImportProps {
  isRecording: boolean;
  // 与 HarImport 接口保持一致；本组件直接保存入库，故不使用该回调
  onImport?: (apis: CapturedApi[]) => void;
}

const METHOD_COLORS: Record<string, string> = {
  GET: 'bg-green-500',
  POST: 'bg-blue-500',
  PUT: 'bg-orange-500',
  DELETE: 'bg-red-500',
  PATCH: 'bg-purple-500',
};

export function SwaggerImport({ isRecording }: SwaggerImportProps) {
  const { toast } = useToast();
  const t = useTranslations('apiCapture');
  const tCommon = useTranslations('common');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [step, setStep] = useState<'input' | 'select' | 'classify'>('input');
  const [inputMode, setInputMode] = useState<'content' | 'url'>('content');
  const [docContent, setDocContent] = useState('');
  const [docUrl, setDocUrl] = useState('');
  const [loading, setLoading] = useState(false);

  const [parsedApis, setParsedApis] = useState<CapturedApi[]>([]);
  const [docInfo, setDocInfo] = useState<{ title: string; version: string; truncated: boolean } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [searchTerm, setSearchTerm] = useState('');
  const [methodFilter, setMethodFilter] = useState<string>('ALL');

  const [classification, setClassification] = useState<{
    platform?: string;
    component?: string;
    feature?: string;
    subFeature?: string;
  }>({});

  const [conflicts, setConflicts] = useState<ApiConflict[]>([]);
  const [showConflictDialog, setShowConflictDialog] = useState(false);
  const [preparedApis, setPreparedApis] = useState<any[]>([]);

  // 语义变更评审
  const [semanticReviewItems, setSemanticReviewItems] = useState<SemanticReviewItem[]>([]);
  const [showSemanticReview, setShowSemanticReview] = useState(false);
  const [pendingSave, setPendingSave] = useState<{ apis: any[]; duplicateCount: number } | null>(null);

  // 统一判重 Key（与 HarImport 保持一致）
  const getApiIdentityKey = (api: any) => {
    const method = String(api?.method || '').toUpperCase();
    let path = String(api?.path || '');
    if (method === 'GET') {
      path = path.split('?')[0];
    }
    return `${method}|${path}`;
  };

  // 读取上传的文件内容到文本框
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setDocContent(String(reader.result || ''));
      setInputMode('content');
    };
    reader.onerror = () => {
      toast({ variant: "destructive", title: t('swagger.fileReadFailed'), description: file.name });
    };
    reader.readAsText(file);
    // 允许重复选择同一文件
    e.target.value = '';
  };

  // 调用后端解析
  const handleParse = async () => {
    const payload =
      inputMode === 'url'
        ? { url: docUrl.trim() }
        : { content: docContent.trim() };

    if (inputMode === 'url' && !docUrl.trim()) {
      toast({ variant: "destructive", title: t('swagger.urlRequired'), description: t('swagger.pleaseEnterUrl') });
      return;
    }
    if (inputMode === 'content' && !docContent.trim()) {
      toast({ variant: "destructive", title: t('emptyContent'), description: t('swagger.pleasePasteOrUpload') });
      return;
    }

    setLoading(true);
    try {
      const response = await fetch('/api/api-library/import-swagger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await response.json();

      if (!result.success) {
        throw new Error(result.error || t('parseFailed'));
      }

      const apis: CapturedApi[] = result.apis;
      setParsedApis(apis);
      setDocInfo(result.info);
      setSelectedIds(new Set(apis.map((api) => api.id)));
      setStep('select');

      toast({
        title: t('parseSuccess'),
        description: `${result.info.title} · ${t('parsedCount')} ${apis.length} ${t('apiRequests')}`,
      });
    } catch (error: any) {
      console.error('Swagger 解析失败:', error);
      toast({ variant: "destructive", title: t('parseFailed'), description: error.message });
    } finally {
      setLoading(false);
    }
  };

  const handleNextToClassify = () => {
    const selectedApis = parsedApis.filter((api) => selectedIds.has(api.id));
    if (selectedApis.length === 0) {
      toast({ variant: "destructive", title: t('noApiSelected'), description: t('selectAtLeastOne') });
      return;
    }
    setStep('classify');
  };

  // 进入分类步骤时，自动用文档 info.title 预填二级分类（component）；
  // 三级分类（feature）保持为空——空表示"按各接口自身的 tag 分配"。
  // 用户可手动清除/修改 component，也可填写 feature 进行整批覆盖。
  useEffect(() => {
    if (step === 'classify' && docInfo?.title && !classification.component) {
      setClassification((prev) => ({ ...prev, component: docInfo.title }));
    }
  }, [step, docInfo?.title]); // eslint-disable-line react-hooks/exhaustive-deps

  const checkConflicts = async (apisToCheck: any[]) => {
    try {
      const response = await fetch('/api/api-library/check-duplicates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apis: apisToCheck }),
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.error || '检查重复失败');
      return result.data;
    } catch (error: any) {
      console.error('检查冲突失败:', error);
      toast({ variant: "destructive", title: "检查失败", description: error.message });
      return [];
    }
  };

  // 基于 method + path 去重
  const deduplicateApis = (apis: any[]) => {
    const seen = new Map<string, any>();
    let duplicateCount = 0;
    apis.forEach((api) => {
      const key = getApiIdentityKey(api);
      if (seen.has(key)) duplicateCount++;
      seen.set(key, api);
    });
    return { deduplicated: Array.from(seen.values()), duplicateCount };
  };

  const handleSaveSelected = async () => {
    const selectedApis = parsedApis.filter((api) => selectedIds.has(api.id));
    if (selectedApis.length === 0) {
      toast({ variant: "destructive", title: t('noApiSelected'), description: t('selectAtLeastOne') });
      return;
    }
    if (!classification.platform) {
      toast({ variant: "destructive", title: t('classificationRequired'), description: t('pleaseSelectPlatform') });
      return;
    }

    setLoading(true);
    try {
      const apisWithClassification = selectedApis.map((api) => {
        // platform 强制使用整批选择（必选）。
        // component / feature：用户在分类页填了就整批统一覆盖；没填则保留各接口自身从 swagger-parser 预填的值
        // （component ← info.title，feature ← operation.tags[0]）。
        const apiAny = api as any;
        return {
          ...api,
          platform: classification.platform,
          component: classification.component ?? apiAny.component,
          feature: classification.feature ?? apiAny.feature,
          subFeature: classification.subFeature?.trim() || undefined,
          importSource: 'swagger',
        };
      });

      const checkResults = await checkConflicts(apisWithClassification);
      const conflictedApis = checkResults.filter((result: any) => result.isDuplicate);

      if (conflictedApis.length > 0) {
        const conflictsData: ApiConflict[] = conflictedApis.map((result: any) => ({
          inputApi: result.inputApi,
          existingApi: result.existingApi,
        }));
        setConflicts(conflictsData);
        setPreparedApis(apisWithClassification);
        setShowConflictDialog(true);
        setLoading(false);
      } else {
        const { deduplicated, duplicateCount } = deduplicateApis(apisWithClassification);
        await saveApis(deduplicated, duplicateCount);
        setLoading(false);
      }
    } catch (error: any) {
      console.error(t('saveFailed'), error);
      toast({ variant: "destructive", title: t('saveFailed'), description: error.message || t('pleaseTryAgainLater') });
      setLoading(false);
    }
  };

  const saveApis = async (apis: any[], duplicateCount: number) => {
    const response = await fetch('/api/api-library/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apis }),
    });
    const result = await response.json();
    if (!result.success) throw new Error(result.error || t('saveFailed'));

    const dedupeInfo = duplicateCount > 0 ? `（已自动去除 ${duplicateCount} 个重复请求）` : '';
    if (result.failed && result.failed > 0) {
      const failedNames = result.failedDetails?.map((f: any) => f.api).join(', ') || '';
      toast({
        title: t('saveSuccess'),
        description: `成功保存 ${result.count} 个API，${result.failed} 个失败${failedNames ? `（${failedNames}）` : ''}`,
      });
    } else {
      toast({ title: t('saveSuccess'), description: `${t('savedCount')} ${result.count} ${t('apisToRepo')}${dedupeInfo}` });
    }
    handleClose();
  };

  // 冲突解决（与 HarImport 一致的逻辑）
  const handleConflictResolve = async (decisions: ConflictDecision[]) => {
    setLoading(true);
    setShowConflictDialog(false);
    try {
      const apisToSave = preparedApis
        .filter((api) => {
          const decision = decisions.find(
            (d) => d.inputApi.id === api.id || (d.inputApi.method === api.method && d.inputApi.path === api.path)
          );
          return !decision || decision.resolution !== 'skip';
        })
        .map((api) => {
          const decision = decisions.find(
            (d) => d.inputApi.id === api.id || (d.inputApi.method === api.method && d.inputApi.path === api.path)
          );
          if (decision?.resolution === 'overwrite') {
            return { ...api, id: decision.existingApi.id, name: decision.existingApi.name, _overwrite: true };
          }
          return api;
        });

      // 分别处理覆盖/创建模式去重
      const deduplicatedApis = apisToSave.reduce((acc: any[], api: any) => {
        if (api._overwrite && api.id) {
          const idx = acc.findIndex((a: any) => a._overwrite && a.id === api.id);
          if (idx === -1) acc.push(api);
          else acc[idx] = api;
        } else {
          const key = getApiIdentityKey(api);
          const idx = acc.findIndex((a: any) => !a._overwrite && getApiIdentityKey(a) === key);
          if (idx === -1) acc.push(api);
          else acc[idx] = api;
        }
        return acc;
      }, []);

      const duplicateCount = apisToSave.length - deduplicatedApis.length;

      if (deduplicatedApis.length > 0) {
        // 语义变更评审：对覆盖（_overwrite）且语义有变更的接口，先评审再保存
        const reviewItems = buildSemanticReviewItems(deduplicatedApis, decisions);
        if (reviewItems.length > 0) {
          setSemanticReviewItems(reviewItems);
          setPendingSave({ apis: deduplicatedApis, duplicateCount });
          setShowSemanticReview(true);
          setConflicts([]);
          setPreparedApis([]);
          return; // 等评审结果
        }
        await saveApis(deduplicatedApis, duplicateCount);
      } else {
        toast({ title: "已取消", description: "所有API都已跳过" });
        handleClose();
      }
      setConflicts([]);
      setPreparedApis([]);
    } catch (error: any) {
      console.error(t('saveFailed'), error);
      toast({ variant: "destructive", title: t('saveFailed'), description: error.message || t('pleaseTryAgainLater') });
    } finally {
      setLoading(false);
    }
  };

  const handleConflictCancel = () => {
    setShowConflictDialog(false);
    setConflicts([]);
    setPreparedApis([]);
    setLoading(false);
  };

  // 解析旧记录的语义（existingApi.businessSemantics 可能是 JSON 字符串）
  const parseExistingSemantics = (raw: any) => {
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  // 对覆盖且语义有变更的接口，构造评审项
  const buildSemanticReviewItems = (
    apisToSave: any[],
    decisions: ConflictDecision[]
  ): SemanticReviewItem[] => {
    const items: SemanticReviewItem[] = [];
    for (const api of apisToSave) {
      if (!api._overwrite) continue; // 仅覆盖的接口需要语义评审
      const incomingBaseline = api.businessSemantics?.baseline;
      if (!incomingBaseline) continue; // 本次无语义，跳过

      const decision = decisions.find(
        (d) => d.existingApi?.id === api.id
      );
      const existingSem = parseExistingSemantics(decision?.existingApi?.businessSemantics);
      const result = diffSemantics(existingSem, incomingBaseline);
      if (result.hasChanges) {
        items.push({
          apiKey: getApiIdentityKey(api),
          apiName: api.name,
          method: api.method,
          path: api.path,
          diffs: result.diffs,
        });
      }
    }
    return items;
  };

  // 评审完成：把决策应用到各接口的 baseline，再保存
  const handleSemanticResolve = async (reviewDecisions: SemanticReviewDecision[]) => {
    setShowSemanticReview(false);
    if (!pendingSave) return;
    setLoading(true);
    try {
      const decisionByKey = new Map(reviewDecisions.map((d) => [d.apiKey, d.decisions]));
      const apis = pendingSave.apis.map((api) => {
        const key = getApiIdentityKey(api);
        const fieldDecisions = decisionByKey.get(key);
        if (!fieldDecisions || !api.businessSemantics?.baseline) return api;
        // keepOld：从本次 baseline 中移除该字段（保留旧值由后端 merge 决定）
        const baseline = { ...api.businessSemantics.baseline };
        for (const fd of fieldDecisions) {
          if (fd.resolution === 'keepOld') {
            delete (baseline as any)[fd.field];
          }
          // accept / keepOverride：baseline 保留文档新值（override 由后端保留）
        }
        return { ...api, businessSemantics: { ...api.businessSemantics, baseline } };
      });
      await saveApis(apis, pendingSave.duplicateCount);
    } catch (error: any) {
      console.error(t('saveFailed'), error);
      toast({ variant: "destructive", title: t('saveFailed'), description: error.message || t('pleaseTryAgainLater') });
    } finally {
      setPendingSave(null);
      setSemanticReviewItems([]);
      setLoading(false);
    }
  };

  const handleSemanticCancel = () => {
    setShowSemanticReview(false);
    setSemanticReviewItems([]);
    setPendingSave(null);
    setLoading(false);
    toast({ title: "已取消", description: "未保存语义变更" });
  };

  const handleClose = () => {
    setDialogOpen(false);
    setStep('input');
    setInputMode('content');
    setDocContent('');
    setDocUrl('');
    setParsedApis([]);
    setDocInfo(null);
    setSelectedIds(new Set());
    setSearchTerm('');
    setMethodFilter('ALL');
    setClassification({});
  };

  const handleToggleApi = (apiId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(apiId)) next.delete(apiId);
      else next.add(apiId);
      return next;
    });
  };

  const handleBack = () => {
    if (step === 'classify') setStep('select');
    else if (step === 'select') {
      setStep('input');
      setSearchTerm('');
      setMethodFilter('ALL');
    }
  };

  const availableMethods = useMemo(() => {
    const methods = new Set(parsedApis.map((api) => api.method));
    return Array.from(methods).sort();
  }, [parsedApis]);

  const filteredApis = useMemo(() => {
    return parsedApis.filter((api) => {
      if (methodFilter !== 'ALL' && api.method !== methodFilter) return false;
      if (searchTerm) {
        const s = searchTerm.toLowerCase();
        if (!api.url.toLowerCase().includes(s) && !api.name?.toLowerCase().includes(s)) return false;
      }
      return true;
    });
  }, [parsedApis, methodFilter, searchTerm]);

  const filteredSelectedCount = useMemo(
    () => filteredApis.filter((api) => selectedIds.has(api.id)).length,
    [filteredApis, selectedIds]
  );

  const handleToggleAll = () => {
    if (filteredSelectedCount === filteredApis.length) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        filteredApis.forEach((api) => next.delete(api.id));
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        filteredApis.forEach((api) => next.add(api.id));
        return next;
      });
    }
  };

  return (
    <>
      <Card className="hover:shadow-md transition-shadow border-[#e5e7eb] dark:border-[#4b5563]">
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-primary/10 rounded-lg">
              <FileCode2 className="h-6 w-6 text-primary" />
            </div>
            <div>
              <CardTitle>{t('swagger.importSwagger')}</CardTitle>
              <CardDescription className="mt-1">{t('swagger.importDesc')}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Button variant="outline" className="w-full" onClick={() => setDialogOpen(true)} disabled={isRecording}>
            <FileCode2 className="mr-2 h-4 w-4" />
            {t('swagger.importSwagger')}
          </Button>
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={(open) => !open && handleClose()}>
        <DialogContent className="sm:max-w-[800px] h-[85vh] flex flex-col p-0">
          <div className="px-6 pt-6">
            <DialogHeader>
              <DialogTitle>
                {step === 'input'
                  ? t('swagger.importSwagger')
                  : step === 'select'
                  ? t('selectApisToSave')
                  : t('selectClassification')}
              </DialogTitle>
              <DialogDescription>
                {step === 'input'
                  ? t('swagger.inputDesc')
                  : step === 'select'
                  ? `${docInfo ? `${docInfo.title} · ` : ''}${t('parsedApisCount')} ${parsedApis.length} ${t('items')}，${t('selectedCount')} ${selectedIds.size} ${t('items')}`
                  : t('selectClassificationDesc')}
              </DialogDescription>
            </DialogHeader>
          </div>

          {step === 'input' ? (
            <div className="flex-1 overflow-hidden flex flex-col px-6">
              <Tabs value={inputMode} onValueChange={(v) => setInputMode(v as 'content' | 'url')} className="flex-1 flex flex-col py-4 min-h-0">
                <TabsList className="w-full grid grid-cols-2">
                  <TabsTrigger value="content">
                    <Upload className="h-4 w-4 mr-2" />
                    {t('swagger.tabPasteUpload')}
                  </TabsTrigger>
                  <TabsTrigger value="url">
                    <Link2 className="h-4 w-4 mr-2" />
                    {t('swagger.tabUrl')}
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="content" className="flex-1 flex flex-col min-h-0 mt-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <Label>{t('swagger.docContent')}</Label>
                    <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                      <Upload className="h-4 w-4 mr-2" />
                      {t('swagger.uploadFile')}
                    </Button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".json,.yaml,.yml,application/json,text/yaml"
                      className="hidden"
                      onChange={handleFileChange}
                    />
                  </div>
                  <Textarea
                    value={docContent}
                    onChange={(e) => setDocContent(e.target.value)}
                    placeholder={t('swagger.contentPlaceholder')}
                    className="font-mono text-xs flex-1 resize-none min-h-0"
                  />
                </TabsContent>

                <TabsContent value="url" className="mt-4 space-y-3">
                  <Label>{t('swagger.docUrl')}</Label>
                  <Input
                    value={docUrl}
                    onChange={(e) => setDocUrl(e.target.value)}
                    placeholder="https://petstore3.swagger.io/api/v3/openapi.json"
                  />
                  <div className="text-xs text-muted-foreground p-3 bg-muted/50 rounded-md space-y-1">
                    <p className="font-semibold">{t('instructions')}</p>
                    <ul className="list-disc list-inside space-y-1 ml-2">
                      <li>{t('swagger.urlHint1')}</li>
                      <li>{t('swagger.urlHint2')}</li>
                    </ul>
                  </div>
                </TabsContent>
              </Tabs>
            </div>
          ) : step === 'select' ? (
            <div className="flex-1 overflow-hidden flex flex-col px-6 min-h-0">
              {docInfo?.truncated && (
                <div className="text-xs text-amber-600 dark:text-amber-400 py-2">
                  {t('swagger.truncatedWarning')}
                </div>
              )}
              <div className="space-y-3 py-4 flex-shrink-0">
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder={t('searchUrlOrName')}
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="pl-9"
                    />
                  </div>
                  <Select value={methodFilter} onValueChange={setMethodFilter}>
                    <SelectTrigger className="w-[140px]">
                      <Filter className="h-4 w-4 mr-2" />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ALL">{t('allMethods')}</SelectItem>
                      {availableMethods.map((method) => (
                        <SelectItem key={method} value={method}>
                          {method}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center justify-between pb-2 border-b border-[#e5e7eb] dark:border-[#4b5563]">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="swagger-select-all"
                      checked={filteredApis.length > 0 && filteredSelectedCount === filteredApis.length}
                      onCheckedChange={handleToggleAll}
                    />
                    <Label htmlFor="swagger-select-all" className="cursor-pointer text-sm">
                      {t('selectAllOnPage')} ({filteredSelectedCount}/{filteredApis.length})
                      {filteredApis.length !== parsedApis.length && (
                        <span className="text-muted-foreground ml-1">
                          · {t('totalSelected')} {selectedIds.size}/{parsedApis.length}
                        </span>
                      )}
                    </Label>
                  </div>
                  <Button variant="ghost" size="sm" onClick={handleToggleAll}>
                    {filteredSelectedCount === filteredApis.length ? (
                      <Square className="h-4 w-4 mr-2" />
                    ) : (
                      <CheckSquare className="h-4 w-4 mr-2" />
                    )}
                    {filteredSelectedCount === filteredApis.length ? t('deselectAll') : t('selectAll')}
                  </Button>
                </div>
              </div>

              {filteredApis.length > 0 ? (
                <ScrollArea className="flex-1 -mx-6 px-6 min-h-0">
                  <div className="space-y-2 py-2">
                    {filteredApis.map((api) => (
                      <div
                        key={api.id}
                        className={`flex items-start gap-3 p-3 rounded-lg border border-[#e5e7eb] dark:border-[#4b5563] transition-colors cursor-pointer ${
                          selectedIds.has(api.id) ? 'bg-primary/5 border-primary/20' : 'hover:bg-muted/50'
                        }`}
                        onClick={() => handleToggleApi(api.id)}
                      >
                        <Checkbox
                          checked={selectedIds.has(api.id)}
                          onCheckedChange={() => handleToggleApi(api.id)}
                          onClick={(e) => e.stopPropagation()}
                        />
                        <div className="flex-1 min-w-0 space-y-1">
                          <div className="flex items-center gap-2">
                            <Badge className={METHOD_COLORS[api.method] || 'bg-gray-500'}>{api.method}</Badge>
                            <span className="font-medium text-sm truncate">{api.name}</span>
                          </div>
                          <p className="text-xs text-muted-foreground font-mono truncate">{api.path}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              ) : (
                <div className="flex-1 flex items-center justify-center text-center p-8 min-h-0">
                  <div>
                    <p className="text-muted-foreground">{t('noMatchingApis')}</p>
                    <p className="text-sm text-muted-foreground mt-1">{t('tryAdjustFilters')}</p>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              <div className="text-xs text-muted-foreground p-3 bg-muted/50 rounded-md space-y-1">
                <p>{t('swagger.autoClassifyHint')}</p>
              </div>
              <FourLayerSelector value={classification} onChange={setClassification} allowCreate={true} enableSubFeature={true} />
            </div>
          )}

          <div className="px-6 py-4 border-t border-[#e5e7eb] dark:border-[#4b5563] bg-background">
            <DialogFooter>
              <Button type="button" variant="outline" onClick={step === 'input' ? handleClose : handleBack} disabled={loading}>
                {step === 'input' ? tCommon('cancel') : t('previousStep')}
              </Button>
              <Button
                type="button"
                onClick={step === 'input' ? handleParse : step === 'select' ? handleNextToClassify : handleSaveSelected}
                disabled={
                  loading ||
                  (step === 'input' && (inputMode === 'url' ? !docUrl.trim() : !docContent.trim())) ||
                  (step === 'select' && selectedIds.size === 0) ||
                  (step === 'classify' && !classification.platform)
                }
              >
                {step === 'input' ? (
                  <>
                    {loading ? t('swagger.parsing') : t('parse')}
                    <ChevronRight className="ml-2 h-4 w-4" />
                  </>
                ) : step === 'select' ? (
                  <>
                    {t('nextStep')}
                    <ChevronRight className="ml-2 h-4 w-4" />
                  </>
                ) : (
                  <>
                    <Save className="mr-2 h-4 w-4" />
                    {loading ? t('saving') : `${t('saveApis')} ${selectedIds.size} ${t('items')}`}
                  </>
                )}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>

        <ApiConflictResolverDialog
          open={showConflictDialog}
          conflicts={conflicts}
          onResolve={handleConflictResolve}
          onCancel={handleConflictCancel}
        />
      </Dialog>

      <SemanticReviewDialog
        open={showSemanticReview}
        items={semanticReviewItems}
        onResolve={handleSemanticResolve}
        onCancel={handleSemanticCancel}
      />
    </>
  );
}

'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Terminal,
  RefreshCw,
  Search,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Info,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

interface SystemLog {
  time: string;
  level: string;
  op: string | null;
  message: string;
  details: string | null;
}

const LEVELS = ['ERROR', 'WARN', 'INFO', 'SUCCESS', 'DEBUG'];
const OPS = ['CREATE', 'READ', 'UPDATE', 'DELETE', 'EXECUTE', 'AUTH', 'QUERY'];

const ALL = '__all__';

export default function SystemLogsPage() {
  const t = useTranslations('systemLogs');
  const { toast } = useToast();

  const [files, setFiles] = useState<string[]>([]);
  const [file, setFile] = useState<string>('');
  const [level, setLevel] = useState<string>(ALL);
  const [op, setOp] = useState<string>(ALL);
  const [keyword, setKeyword] = useState<string>('');
  const [logs, setLogs] = useState<SystemLog[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(false);

  const scrollRef = useRef<HTMLDivElement>(null);

  // 统一带上鉴权头
  const authHeaders = (): HeadersInit => {
    const token =
      typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  // 加载文件列表
  const fetchFiles = useCallback(async () => {
    try {
      const res = await fetch('/api/system-logs?action=files', {
        headers: authHeaders(),
      });
      const result = await res.json();
      if (result.success) {
        setFiles(result.files || []);
        // 默认选第一个（最新日期的 nextjs-api，若有）
        if (result.files?.length && !file) {
          const preferred =
            result.files.find((f: string) => f.includes('nextjs-api')) ||
            result.files[0];
          setFile(preferred);
        }
      } else {
        toast({
          title: t('loadFailed'),
          description: result.error,
          variant: 'destructive',
        });
      }
    } catch (e: any) {
      toast({
        title: t('loadFailed'),
        description: e.message,
        variant: 'destructive',
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 加载日志
  const fetchLogs = useCallback(async () => {
    if (!file) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ file });
      if (level !== ALL) params.set('level', level);
      if (op !== ALL) params.set('op', op);
      if (keyword.trim()) params.set('q', keyword.trim());
      const res = await fetch(`/api/system-logs?${params.toString()}`, {
        headers: authHeaders(),
      });
      const result = await res.json();
      if (result.success) {
        setLogs(result.logs || []);
        setTotal(result.total || 0);
      } else {
        toast({
          title: t('loadFailed'),
          description: result.error,
          variant: 'destructive',
        });
        setLogs([]);
        setTotal(0);
      }
    } catch (e: any) {
      toast({
        title: t('loadFailed'),
        description: e.message,
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, level, op, keyword]);

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  // 文件/级别/操作变化时自动刷新（关键词用按钮或回车触发）
  useEffect(() => {
    if (file) fetchLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, level, op]);

  // 日志更新后滚到底部
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  const getLevelIcon = (lvl: string) => {
    switch (lvl) {
      case 'SUCCESS':
        return <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />;
      case 'ERROR':
        return <XCircle className="h-4 w-4 text-red-500 shrink-0" />;
      case 'WARN':
        return <AlertCircle className="h-4 w-4 text-yellow-500 shrink-0" />;
      case 'INFO':
        return <Info className="h-4 w-4 text-blue-500 shrink-0" />;
      default:
        return <Terminal className="h-4 w-4 text-gray-500 shrink-0" />;
    }
  };

  const getLevelColor = (lvl: string) => {
    switch (lvl) {
      case 'SUCCESS':
        return 'text-green-600 dark:text-green-400';
      case 'ERROR':
        return 'text-red-600 dark:text-red-400';
      case 'WARN':
        return 'text-yellow-600 dark:text-yellow-400';
      case 'INFO':
        return 'text-blue-600 dark:text-blue-400';
      default:
        return 'text-gray-600 dark:text-gray-400';
    }
  };

  return (
    <div className="flex-1 space-y-4 p-6">
      {/* 标题 */}
      <div className="flex items-center gap-2">
        <Terminal className="h-5 w-5 text-amber-600" />
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <Badge variant="secondary" className="ml-2">
          {t('adminOnly')}
        </Badge>
      </div>

      {/* 过滤栏 */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-end gap-3">
            {/* 文件 */}
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">
                {t('file')}
              </label>
              <Select value={file} onValueChange={setFile}>
                <SelectTrigger className="w-[260px] h-9">
                  <SelectValue placeholder={t('selectFile')} />
                </SelectTrigger>
                <SelectContent>
                  {files.map((f) => (
                    <SelectItem key={f} value={f}>
                      {f}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* 级别 */}
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">
                {t('level')}
              </label>
              <Select value={level} onValueChange={setLevel}>
                <SelectTrigger className="w-[130px] h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t('allLevels')}</SelectItem>
                  {LEVELS.map((l) => (
                    <SelectItem key={l} value={l}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* 操作类型 */}
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">
                {t('operation')}
              </label>
              <Select value={op} onValueChange={setOp}>
                <SelectTrigger className="w-[130px] h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t('allOperations')}</SelectItem>
                  {OPS.map((o) => (
                    <SelectItem key={o} value={o}>
                      {o}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* 关键词 */}
            <div className="space-y-1 flex-1 min-w-[200px]">
              <label className="text-xs text-muted-foreground">
                {t('keyword')}
              </label>
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && fetchLogs()}
                  placeholder={t('keywordPlaceholder')}
                  className="pl-8 h-9"
                />
              </div>
            </div>

            {/* 刷新 */}
            <Button onClick={fetchLogs} disabled={loading} className="h-9">
              <RefreshCw
                className={cn('h-4 w-4 mr-2', loading && 'animate-spin')}
              />
              {t('refresh')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 日志区 */}
      <Card>
        <CardHeader className="py-3 px-4 border-b border-[#e5e7eb] dark:border-[#4b5563]">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Terminal className="h-4 w-4" />
              <span>{file || t('noFile')}</span>
            </div>
            <Badge variant="outline">
              {t('matchCount', { count: total })}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="h-[600px] bg-muted/30" ref={scrollRef as any}>
            {logs.length === 0 ? (
              <div className="flex items-center justify-center h-[600px] text-muted-foreground text-sm">
                {loading ? t('loading') : t('empty')}
              </div>
            ) : (
              <div className="divide-y divide-[#e5e7eb] dark:divide-[#4b5563]">
                {logs.map((log, index) => (
                  <div
                    key={index}
                    className={cn(
                      'py-1 px-3 font-mono text-xs hover:bg-muted/50 transition-colors border-l-2',
                      log.level === 'ERROR'
                        ? 'border-l-red-500'
                        : log.level === 'SUCCESS'
                        ? 'border-l-green-500'
                        : log.level === 'WARN'
                        ? 'border-l-yellow-500'
                        : 'border-l-transparent'
                    )}
                  >
                    <div className="flex items-start gap-2">
                      <span className="text-muted-foreground select-none">
                        {log.time}
                      </span>
                      {getLevelIcon(log.level)}
                      <span
                        className={cn(
                          'font-medium select-none',
                          getLevelColor(log.level)
                        )}
                      >
                        [{log.level}]
                      </span>
                      {log.op && (
                        <Badge variant="outline" className="text-xs shrink-0">
                          {log.op}
                        </Badge>
                      )}
                      <span className="flex-1 break-all">{log.message}</span>
                    </div>
                    {log.details && (
                      <div className="mt-1 ml-24 p-2 bg-muted rounded text-xs overflow-x-auto">
                        <pre className="whitespace-pre-wrap break-all">
                          {log.details}
                        </pre>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

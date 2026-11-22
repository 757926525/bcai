import React, { useEffect, useState } from 'react';
import {
  BookOpen,
  CloudUpload,
  Database,
  Download,
  FileText,
  HardDrive,
  Image as ImageIcon,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  BucketStatusInfo,
  Conversation,
  DbProviderType,
  DbStatusInfo,
  S3AddressingStyle,
  SavedAsset,
  SyncStatusInfo,
} from '../types';
import { formatBytes, formatDateTime, uid } from '../utils/format';

interface DatabaseDrawerProps {
  open: boolean;
  onClose: () => void;
  conversations: Conversation[];
  onRestoreConversations: (convs: Conversation[]) => void;
  dbStatus: DbStatusInfo;
  bucketStatus: BucketStatusInfo;
  syncStatus: SyncStatusInfo;
  onRefreshStatuses: () => Promise<void>;
  onSyncConversations: (target?: 'auto' | 'd1' | 'bucket' | 'both') => Promise<void>;
}

interface BucketObjectItem {
  key: string;
  size: number;
  lastModified: string;
}

const DB_PROVIDERS: Array<{ id: DbProviderType; label: string; badge: string; hint: string }> = [
  { id: 'd1-http', label: 'Cloudflare D1', badge: '5GB 免费 · 自动建表', hint: '需要 Account ID、Database UUID 与含 D1:Edit 权限的 CF API Token。' },
  { id: 'turso', label: 'Turso / libSQL', badge: '9GB 免费 · SQLite', hint: '填写 libsql://...turso.io 或 https://...turso.io 与 Auth Token，自动建表。' },
  { id: 'supabase', label: 'Supabase Postgres', badge: '500MB 免费 · REST', hint: '填写 Project URL 与 service_role/anon Key（请先在 SQL Editor 运行 schema.sql）。' },
  { id: 'neon', label: 'Neon Serverless PG', badge: '0.5GB 免费 · 自动建表', hint: '填写 Neon PostgreSQL 连接字符串，通过 HTTPS SQL API 自动建表。' },
  { id: 'upstash', label: 'Upstash Redis REST', badge: '免费 KV · 零冷启动', hint: '填写 Upstash REST URL 与 REST Token，支持毫秒级读写。' },
];

const BUCKET_PRESETS: Array<{
  id: string;
  label: string;
  endpointHint: string;
  defaultRegion: string;
  style: S3AddressingStyle;
}> = [
  { id: 'r2', label: 'Cloudflare R2', endpointHint: 'https://<ACCOUNT_ID>.r2.cloudflarestorage.com', defaultRegion: 'auto', style: 'path' },
  { id: 'oss', label: '阿里云 OSS', endpointHint: 'https://oss-cn-hangzhou.aliyuncs.com', defaultRegion: 'cn-hangzhou', style: 'virtual' },
  { id: 'cos', label: '腾讯云 COS', endpointHint: 'https://cos.ap-guangzhou.myqcloud.com', defaultRegion: 'ap-guangzhou', style: 'virtual' },
  { id: 'aws', label: 'AWS S3', endpointHint: 'https://s3.us-east-1.amazonaws.com', defaultRegion: 'us-east-1', style: 'virtual' },
  { id: 'minio', label: 'MinIO / 自建 S3', endpointHint: 'https://s3.yourdomain.com', defaultRegion: 'us-east-1', style: 'path' },
  { id: 'b2', label: 'Backblaze B2 / 七牛 Kodo', endpointHint: 'https://s3.us-west-004.backblazeb2.com', defaultRegion: 'us-west-004', style: 'path' },
];

export const DatabaseDrawer: React.FC<DatabaseDrawerProps> = ({
  open,
  onClose,
  conversations,
  onRestoreConversations,
  dbStatus,
  bucketStatus,
  syncStatus,
  onRefreshStatuses,
  onSyncConversations,
}) => {
  const [items, setItems] = useState<SavedAsset[]>([]);
  const [bucketItems, setBucketItems] = useState<BucketObjectItem[]>([]);
  const [filterType, setFilterType] = useState<'all' | 'image' | 'file'>('all');
  const [uploadTarget, setUploadTarget] = useState<'db' | 'bucket'>('db');
  const [loading, setLoading] = useState(false);
  const [showDbGuide, setShowDbGuide] = useState(false);

  // Multi-DB Config State
  const [dbProvider, setDbProvider] = useState<DbProviderType>('d1-http');
  const [accountId, setAccountId] = useState('');
  const [databaseId, setDatabaseId] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [tursoUrl, setTursoUrl] = useState('');
  const [tursoAuthToken, setTursoAuthToken] = useState('');
  const [supabaseUrl, setSupabaseUrl] = useState('');
  const [supabaseKey, setSupabaseKey] = useState('');
  const [neonConnStr, setNeonConnStr] = useState('');
  const [upstashUrl, setUpstashUrl] = useState('');
  const [upstashToken, setUpstashToken] = useState('');

  const [bindingMsg, setBindingMsg] = useState('');
  const [bindingErr, setBindingErr] = useState('');
  const [savingBind, setSavingBind] = useState(false);

  // Multi-Bucket (R2 / OSS / COS / S3 / MinIO) Config State
  const [bucketPreset, setBucketPreset] = useState('r2');
  const [s3Endpoint, setS3Endpoint] = useState('');
  const [s3Region, setS3Region] = useState('auto');
  const [s3Bucket, setS3Bucket] = useState('');
  const [s3AccessKey, setS3AccessKey] = useState('');
  const [s3SecretKey, setS3SecretKey] = useState('');
  const [s3Style, setS3Style] = useState<S3AddressingStyle>('path');
  const [bucketMsg, setBucketMsg] = useState('');
  const [bucketErr, setBucketErr] = useState('');
  const [savingBucket, setSavingBucket] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      await onRefreshStatuses();
      const [listRes, bktRes] = await Promise.all([
        fetch(`/api/db/items${filterType === 'all' ? '' : `?type=${filterType}`}`),
        fetch('/api/bucket/items'),
      ]);
      if (listRes.ok) {
        const listData = (await listRes.json()) as { items?: SavedAsset[] };
        setItems(listData.items || []);
      }
      if (bktRes.ok) {
        const bktData = (await bktRes.json()) as { items?: BucketObjectItem[] };
        setBucketItems(bktData.items || []);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) refresh();
  }, [open, filterType]);

  if (!open) return null;

  const canSubmitDb = (() => {
    if (dbProvider === 'd1-http') return Boolean(accountId.trim() && databaseId.trim() && apiToken.trim());
    if (dbProvider === 'turso') return Boolean(tursoUrl.trim() && tursoAuthToken.trim());
    if (dbProvider === 'supabase') return Boolean(supabaseUrl.trim() && supabaseKey.trim());
    if (dbProvider === 'neon') return Boolean(neonConnStr.trim());
    return Boolean(upstashUrl.trim() && upstashToken.trim());
  })();

  const handleBindDb = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingBind(true);
    setBindingMsg('');
    setBindingErr('');
    try {
      const res = await fetch('/api/db/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: dbProvider,
          accountId,
          databaseId,
          apiToken,
          tursoUrl,
          tursoAuthToken,
          supabaseUrl,
          supabaseKey,
          neonConnectionString: neonConnStr,
          upstashUrl,
          upstashToken,
        }),
      });
      const data = (await res.json()) as { message?: string; error?: string };
      if (!res.ok) throw new Error(data.error || '数据库绑定失败');
      setBindingMsg(data.message || '远程数据库绑定成功');
      setApiToken('');
      setTursoAuthToken('');
      setSupabaseKey('');
      setNeonConnStr('');
      setUpstashToken('');
      refresh();
    } catch (err: any) {
      setBindingErr(err?.message || '绑定失败');
    } finally {
      setSavingBind(false);
    }
  };

  const handleUnbindDb = async () => {
    await fetch('/api/db/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clear: true }),
    });
    setBindingMsg('已解绑远程数据库，切回本地持久化');
    refresh();
  };

  const applyBucketPreset = (presetId: string) => {
    setBucketPreset(presetId);
    const p = BUCKET_PRESETS.find((x) => x.id === presetId);
    if (!p) return;
    setS3Region(p.defaultRegion);
    setS3Style(p.style);
  };

  const handleBindBucket = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingBucket(true);
    setBucketMsg('');
    setBucketErr('');
    try {
      const res = await fetch('/api/bucket/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          endpoint: s3Endpoint,
          region: s3Region,
          bucket: s3Bucket,
          accessKeyId: s3AccessKey,
          secretAccessKey: s3SecretKey,
          addressingStyle: s3Style,
        }),
      });
      const data = (await res.json()) as { message?: string; error?: string };
      if (!res.ok) throw new Error(data.error || '存储桶绑定失败');
      setBucketMsg(data.message || '对象存储桶绑定成功');
      setS3SecretKey('');
      refresh();
    } catch (err: any) {
      setBucketErr(err?.message || '绑定失败');
    } finally {
      setSavingBucket(false);
    }
  };

  const handleUnbindBucket = async () => {
    await fetch('/api/bucket/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clear: true }),
    });
    setBucketMsg('已清除存储桶配置');
    refresh();
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const isImage = file.type.startsWith('image/');
    const reader = new FileReader();
    reader.onload = async () => {
      const contentData = String(reader.result || '');
      if (uploadTarget === 'bucket') {
        const res = await fetch('/api/bucket/upload', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: file.name,
            mimeType: file.type || 'application/octet-stream',
            type: isImage ? 'image' : 'file',
            contentData,
          }),
        });
        if (!res.ok) {
          const d = (await res.json().catch(() => ({}))) as { error?: string };
          setBucketErr(d.error || '上传存储桶失败');
        }
      } else {
        await fetch('/api/db/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: uid(),
            type: isImage ? 'image' : 'file',
            name: file.name,
            mimeType: file.type || 'text/plain',
            sizeBytes: file.size,
            contentData,
          }),
        });
      }
      refresh();
    };
    if (isImage) reader.readAsDataURL(file);
    else reader.readAsText(file);
    e.target.value = '';
  };

  const handleDelete = async (item: SavedAsset) => {
    if (item.storage_location === 'bucket' && item.bucket_key) {
      await fetch(`/api/bucket/items?key=${encodeURIComponent(item.bucket_key)}`, { method: 'DELETE' });
    }
    await fetch(`/api/db/items/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    refresh();
  };

  const handleDeleteBucketObject = async (key: string) => {
    await fetch(`/api/bucket/items?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
    refresh();
  };

  const handleDownloadAsset = (item: SavedAsset) => {
    if (item.storage_location === 'bucket' && item.bucket_key) {
      window.location.href = `/api/bucket/download?key=${encodeURIComponent(item.bucket_key)}`;
      return;
    }
    const a = document.createElement('a');
    if (item.type === 'image' && item.content_data.startsWith('data:')) {
      a.href = item.content_data;
    } else {
      const blob = new Blob([item.content_data], { type: item.mime_type || 'text/plain;charset=utf-8' });
      a.href = URL.createObjectURL(blob);
    }
    a.download = item.name;
    a.click();
  };

  const handlePullCloudConvs = async () => {
    try {
      const res = await fetch('/api/sync/conversations');
      const d = (await res.json()) as { conversations?: Conversation[]; error?: string };
      if (!res.ok) throw new Error(d.error || '拉取失败');
      if (Array.isArray(d.conversations) && d.conversations.length > 0) {
        onRestoreConversations(d.conversations);
        setBindingMsg(`已从云端恢复 ${d.conversations.length} 条会话历史`);
      } else {
        setBindingMsg('云端暂无已同步的会话记录');
      }
    } catch (e: any) {
      setBindingErr(e?.message || '恢复会话失败');
    }
  };

  const renderStorageLocationBadge = (loc?: string) => {
    if (loc === 'bucket') {
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-sky-700 dark:text-sky-400 whitespace-nowrap">
          <HardDrive className="w-3 h-3" />
          <span>对象存储桶</span>
        </span>
      );
    }
    if (loc && loc !== 'local') {
      const map: Record<string, string> = {
        d1: 'Cloudflare D1',
        turso: 'Turso libSQL',
        supabase: 'Supabase',
        neon: 'Neon PG',
        upstash: 'Upstash Redis',
      };
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400 whitespace-nowrap">
          <Database className="w-3 h-3" />
          <span>{map[loc] || loc}</span>
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 text-xs wb-muted whitespace-nowrap">
        <Database className="w-3 h-3" />
        <span>本地存储</span>
      </span>
    );
  };

  const activeDbMeta = DB_PROVIDERS.find((d) => d.id === dbProvider) || DB_PROVIDERS[0];
  const activeBucketPreset = BUCKET_PRESETS.find((b) => b.id === bucketPreset) || BUCKET_PRESETS[0];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-2 sm:p-4">
      <div className="w-full max-w-5xl max-h-[94vh] flex flex-col rounded-xl border wb-border wb-panel shadow-xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b wb-border gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <Database className="w-5 h-5 wb-accent-text shrink-0" />
            <div className="min-w-0">
              <h2 className="text-base sm:text-lg font-semibold wb-ink truncate">
                多数据库（D1 / Turso / Supabase / Neon / Upstash）· 多存储桶管理
              </h2>
              <p className="text-xs wb-muted truncate">
                支持 Cloudflare D1/R2、Turso、Supabase、Neon、Upstash 及阿里云 OSS / 腾讯云 COS / S3 / MinIO
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-10 h-10 rounded-lg flex items-center justify-center wb-muted hover:bg-black/5 dark:hover:bg-white/5 shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-5">
          {/* 3 Real Status Lights Bar */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="rounded-xl border wb-border wb-bg p-3 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xs font-semibold wb-ink">数据库连接状态灯</div>
                <div className="text-[11px] wb-muted truncate">{dbStatus.label}</div>
              </div>
              <span className="inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap shrink-0">
                <span
                  className={`w-2.5 h-2.5 rounded-full ${
                    dbStatus.connected ? 'bg-emerald-600' : dbStatus.d1Bound ? 'bg-red-600' : 'bg-amber-500'
                  }`}
                />
                <span>{dbStatus.connected ? '已连通' : dbStatus.d1Bound ? '异常' : '本地回退'}</span>
              </span>
            </div>

            <div className="rounded-xl border wb-border wb-bg p-3 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xs font-semibold wb-ink">存储桶连接状态灯</div>
                <div className="text-[11px] wb-muted truncate">{bucketStatus.label}</div>
              </div>
              <span className="inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap shrink-0">
                <span
                  className={`w-2.5 h-2.5 rounded-full ${
                    bucketStatus.connected ? 'bg-emerald-600' : bucketStatus.configured ? 'bg-red-600' : 'bg-slate-400'
                  }`}
                />
                <span>{bucketStatus.connected ? '已连通' : bucketStatus.configured ? '异常' : '未连接'}</span>
              </span>
            </div>

            <div className="rounded-xl border wb-border wb-bg p-3 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xs font-semibold wb-ink">历史同步状态灯</div>
                <div className="text-[11px] wb-muted truncate">
                  {syncStatus.lastSyncedAt ? `${syncStatus.message} · ${formatDateTime(syncStatus.lastSyncedAt)}` : syncStatus.message}
                </div>
              </div>
              <span className="inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap shrink-0">
                <span
                  className={`w-2.5 h-2.5 rounded-full ${
                    syncStatus.status === 'success'
                      ? 'bg-emerald-600'
                      : syncStatus.status === 'syncing'
                      ? 'bg-amber-500 animate-pulse'
                      : syncStatus.status === 'error'
                      ? 'bg-red-600'
                      : 'bg-slate-400'
                  }`}
                />
                <span>
                  {syncStatus.status === 'success'
                    ? '同步成功'
                    : syncStatus.status === 'syncing'
                    ? '同步中'
                    : syncStatus.status === 'error'
                    ? '同步失败'
                    : '未同步'}
                </span>
              </span>
            </div>
          </div>

          {/* Conversation History Sync Bar */}
          <div className="rounded-xl border wb-border wb-bg p-3.5 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs wb-ink">
              <span className="font-semibold">对话历史同步 ({conversations.length} 个会话)</span>
              <span className="wb-muted ml-2">支持双向同步到已绑定的远程数据库与对象存储桶。</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => onSyncConversations('auto')}
                disabled={syncStatus.status === 'syncing'}
                className="h-9 px-3.5 rounded-lg wb-accent text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                <CloudUpload className="w-3.5 h-3.5" />
                <span>{syncStatus.status === 'syncing' ? '同步中...' : '立即同步历史'}</span>
              </button>
              <button
                type="button"
                onClick={handlePullCloudConvs}
                className="h-9 px-3 rounded-lg border wb-border wb-panel text-xs font-medium wb-ink hover:opacity-80"
              >
                从云端恢复历史
              </button>
            </div>
          </div>

          {/* Multi-Database Selector & Config Form */}
          <form onSubmit={handleBindDb} className="rounded-xl border wb-border p-4 space-y-3 wb-bg">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold wb-ink">选择并绑定远程数据库</h3>
                <p className="text-xs wb-muted">{activeDbMeta.hint}</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowDbGuide((v) => !v)}
                  className="h-8 px-3 rounded-lg border wb-border wb-panel text-xs font-medium wb-accent-text inline-flex items-center gap-1"
                >
                  <BookOpen className="w-3.5 h-3.5" />
                  <span>{showDbGuide ? '收起接入说明' : '多数据库接入指南'}</span>
                </button>
                {dbStatus.d1Bound && (
                  <button
                    type="button"
                    onClick={handleUnbindDb}
                    className="h-8 px-3 rounded-lg border wb-border wb-panel text-xs wb-muted hover:wb-ink"
                  >
                    解绑数据库
                  </button>
                )}
              </div>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {DB_PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setDbProvider(p.id)}
                  className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
                    dbProvider === p.id ? 'border-blue-600 wb-tint wb-accent-text' : 'wb-border wb-panel wb-ink'
                  }`}
                >
                  <span>{p.label}</span>
                  <span className="ml-1.5 text-[10px] opacity-75">{p.badge}</span>
                </button>
              ))}
            </div>

            {showDbGuide && (
              <div className="rounded-lg border wb-border wb-panel p-3.5 text-xs space-y-1.5 leading-relaxed wb-muted">
                <div className="font-semibold wb-ink">多数据库配置要点：</div>
                <p>• <strong className="wb-ink">Cloudflare D1</strong>：Pages 原生自动绑定 <code className="font-mono">env.DB</code>；独立服务器填写 Account ID + Database UUID + Token 自动建表。</p>
                <p>• <strong className="wb-ink">Turso / Neon</strong>：填入数据库 URL/连接串与 Token 即可自动完成 <code className="font-mono">media_assets</code> 与 <code className="font-mono">conversations</code> 建表。</p>
                <p>• <strong className="wb-ink">Supabase</strong>：先在 Supabase SQL Editor 执行仓库根目录 <code className="font-mono">schema.sql</code>，再填入 Project URL 与 Service Role Key。</p>
                <p>• <strong className="wb-ink">Upstash Redis</strong>：纯 HTTPS REST 接口，适合边缘节点高频读写同步。</p>
              </div>
            )}

            {dbProvider === 'd1-http' && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                <input type="text" value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder="Cloudflare Account ID" className="h-10 px-3 rounded-lg border wb-border wb-panel text-xs font-mono wb-ink" />
                <input type="text" value={databaseId} onChange={(e) => setDatabaseId(e.target.value)} placeholder="D1 Database UUID" className="h-10 px-3 rounded-lg border wb-border wb-panel text-xs font-mono wb-ink" />
                <input type="password" value={apiToken} onChange={(e) => setApiToken(e.target.value)} placeholder="CF API Token (含 D1 Edit 权限)" className="h-10 px-3 rounded-lg border wb-border wb-panel text-xs font-mono wb-ink" />
              </div>
            )}
            {dbProvider === 'turso' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                <input type="text" value={tursoUrl} onChange={(e) => setTursoUrl(e.target.value)} placeholder="Turso URL (libsql://your-db.turso.io)" className="h-10 px-3 rounded-lg border wb-border wb-panel text-xs font-mono wb-ink" />
                <input type="password" value={tursoAuthToken} onChange={(e) => setTursoAuthToken(e.target.value)} placeholder="Turso Auth Token" className="h-10 px-3 rounded-lg border wb-border wb-panel text-xs font-mono wb-ink" />
              </div>
            )}
            {dbProvider === 'supabase' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                <input type="text" value={supabaseUrl} onChange={(e) => setSupabaseUrl(e.target.value)} placeholder="Supabase Project URL (https://xxx.supabase.co)" className="h-10 px-3 rounded-lg border wb-border wb-panel text-xs font-mono wb-ink" />
                <input type="password" value={supabaseKey} onChange={(e) => setSupabaseKey(e.target.value)} placeholder="Supabase Service Role / Anon Key" className="h-10 px-3 rounded-lg border wb-border wb-panel text-xs font-mono wb-ink" />
              </div>
            )}
            {dbProvider === 'neon' && (
              <input type="password" value={neonConnStr} onChange={(e) => setNeonConnStr(e.target.value)} placeholder="postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require" className="w-full h-10 px-3 rounded-lg border wb-border wb-panel text-xs font-mono wb-ink" />
            )}
            {dbProvider === 'upstash' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                <input type="text" value={upstashUrl} onChange={(e) => setUpstashUrl(e.target.value)} placeholder="Upstash Redis REST URL (https://xxx.upstash.io)" className="h-10 px-3 rounded-lg border wb-border wb-panel text-xs font-mono wb-ink" />
                <input type="password" value={upstashToken} onChange={(e) => setUpstashToken(e.target.value)} placeholder="Upstash REST Token" className="h-10 px-3 rounded-lg border wb-border wb-panel text-xs font-mono wb-ink" />
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="submit"
                disabled={savingBind || !canSubmitDb}
                className="h-9 px-4 rounded-lg wb-accent text-xs font-medium disabled:opacity-40"
              >
                {savingBind ? '正在验证并初始化...' : `验证并绑定 ${activeDbMeta.label}`}
              </button>
              {bindingMsg && <span className="text-xs text-emerald-600 dark:text-emerald-400">{bindingMsg}</span>}
              {bindingErr && <span className="text-xs text-red-600 dark:text-red-400">{bindingErr}</span>}
            </div>
          </form>

          {/* Multi-Cloud Storage Bucket Binding Form */}
          <form onSubmit={handleBindBucket} className="rounded-xl border wb-border p-4 space-y-3 wb-bg">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold wb-ink">选择并绑定对象存储桶（R2 · 阿里云 OSS · 腾讯云 COS · AWS S3 · MinIO）</h3>
                <p className="text-xs wb-muted">
                  Endpoint 参考：<code className="font-mono">{activeBucketPreset.endpointHint}</code> · 默认签名模式：<code className="font-mono">{s3Style}</code>
                </p>
              </div>
              {bucketStatus.configured && (
                <button
                  type="button"
                  onClick={handleUnbindBucket}
                  className="h-8 px-3 rounded-lg border wb-border wb-panel text-xs wb-muted hover:wb-ink"
                >
                  清除存储桶配置
                </button>
              )}
            </div>

            <div className="flex flex-wrap gap-1.5">
              {BUCKET_PRESETS.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => applyBucketPreset(b.id)}
                  className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
                    bucketPreset === b.id ? 'border-blue-600 wb-tint wb-accent-text' : 'wb-border wb-panel wb-ink'
                  }`}
                >
                  {b.label}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
              <input
                type="text"
                value={s3Endpoint}
                onChange={(e) => setS3Endpoint(e.target.value)}
                placeholder={activeBucketPreset.endpointHint}
                className="lg:col-span-2 h-10 px-3 rounded-lg border wb-border wb-panel text-xs font-mono wb-ink"
              />
              <input
                type="text"
                value={s3Bucket}
                onChange={(e) => setS3Bucket(e.target.value)}
                placeholder="Bucket 名称"
                className="h-10 px-3 rounded-lg border wb-border wb-panel text-xs font-mono wb-ink"
              />
              <input
                type="text"
                value={s3AccessKey}
                onChange={(e) => setS3AccessKey(e.target.value)}
                placeholder="Access Key ID"
                className="h-10 px-3 rounded-lg border wb-border wb-panel text-xs font-mono wb-ink"
              />
              <input
                type="password"
                value={s3SecretKey}
                onChange={(e) => setS3SecretKey(e.target.value)}
                placeholder="Secret Access Key"
                className="h-10 px-3 rounded-lg border wb-border wb-panel text-xs font-mono wb-ink"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={s3Region}
                  onChange={(e) => setS3Region(e.target.value)}
                  placeholder="Region (auto)"
                  className="w-28 h-9 px-2.5 rounded-lg border wb-border wb-panel text-xs font-mono wb-ink"
                />
                <select
                  value={s3Style}
                  onChange={(e) => setS3Style(e.target.value as S3AddressingStyle)}
                  className="h-9 px-2.5 rounded-lg border wb-border wb-panel text-xs wb-ink"
                  title="S3 URL 访问样式（OSS/COS 用 Virtual-Hosted，R2/MinIO 用 Path-Style）"
                >
                  <option value="path">Path-Style (R2 / MinIO / B2)</option>
                  <option value="virtual">Virtual-Hosted (阿里云 OSS / 腾讯云 COS / AWS)</option>
                </select>
                <button
                  type="submit"
                  disabled={savingBucket || !s3Endpoint.trim() || !s3Bucket.trim() || !s3AccessKey.trim() || !s3SecretKey.trim()}
                  className="h-9 px-4 rounded-lg wb-accent text-xs font-medium disabled:opacity-40"
                >
                  {savingBucket ? '验证存储桶...' : '验证并绑定存储桶'}
                </button>
              </div>
              {bucketMsg && <span className="text-xs text-emerald-600 dark:text-emerald-400">{bucketMsg}</span>}
              {bucketErr && <span className="text-xs text-red-600 dark:text-red-400">{bucketErr}</span>}
            </div>
          </form>

          {/* Saved Images & Files Table with Storage Location */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1 p-1 rounded-lg wb-bg border wb-border">
                {(['all', 'image', 'file'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setFilterType(t)}
                    className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                      filterType === t ? 'wb-panel wb-ink shadow-sm' : 'wb-muted'
                    }`}
                  >
                    {t === 'all' ? '全部记录' : t === 'image' ? '图片' : '代码与文件'}
                  </button>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={uploadTarget}
                  onChange={(e) => setUploadTarget(e.target.value as 'db' | 'bucket')}
                  className="h-9 px-2.5 rounded-lg border wb-border wb-panel text-xs wb-ink"
                >
                  <option value="db">上传目标：数据库</option>
                  <option value="bucket" disabled={!bucketStatus.connected}>
                    上传目标：对象存储桶 {!bucketStatus.connected ? '(未连通)' : ''}
                  </option>
                </select>

                <label className="h-9 px-3 rounded-lg wb-accent text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer">
                  <Upload className="w-3.5 h-3.5" />
                  <span>上传文件/图片</span>
                  <input type="file" onChange={handleFileUpload} className="hidden" />
                </label>

                <button
                  type="button"
                  onClick={refresh}
                  className="h-9 px-3 rounded-lg border wb-border wb-panel text-xs wb-ink hover:opacity-80 inline-flex items-center gap-1.5"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                  <span>刷新</span>
                </button>
              </div>
            </div>

            {items.length === 0 && bucketItems.length === 0 ? (
              <div className="rounded-xl border border-dashed wb-border py-10 text-center text-xs wb-muted">
                暂无已保存的图片或文件。可在上方选择目标（数据库或存储桶）上传，或在绘图/编程区一键保存。
              </div>
            ) : (
              <div className="border wb-border rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="wb-bg border-b wb-border wb-muted">
                      <tr>
                        <th className="py-2.5 px-3 font-medium">名称 / 预览</th>
                        <th className="py-2.5 px-3 font-medium">存储位置</th>
                        <th className="py-2.5 px-3 font-medium text-right">大小</th>
                        <th className="py-2.5 px-3 font-medium">保存时间</th>
                        <th className="py-2.5 px-3 font-medium text-right">操作（下载/删除）</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y wb-border">
                      {items.map((item) => (
                        <tr key={item.id} className="hover:bg-black/[0.02] dark:hover:bg-white/[0.02]">
                          <td className="py-2.5 px-3">
                            <div className="flex items-center gap-2.5">
                              {item.type === 'image' && item.content_data.startsWith('data:') ? (
                                <img
                                  src={item.content_data}
                                  alt={item.name}
                                  className="w-9 h-9 rounded object-cover border wb-border shrink-0"
                                />
                              ) : item.type === 'image' ? (
                                <ImageIcon className="w-4 h-4 wb-muted shrink-0" />
                              ) : (
                                <FileText className="w-4 h-4 wb-muted shrink-0" />
                              )}
                              <div className="min-w-0">
                                <div className="font-medium wb-ink truncate max-w-[240px]">{item.name}</div>
                                {item.bucket_key && (
                                  <div className="text-[11px] font-mono wb-muted truncate max-w-[240px]">
                                    {item.bucket_key}
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="py-2.5 px-3">{renderStorageLocationBadge(item.storage_location)}</td>
                          <td className="py-2.5 px-3 text-right font-mono tabular-nums wb-muted">
                            {formatBytes(item.size_bytes)}
                          </td>
                          <td className="py-2.5 px-3 font-mono tabular-nums wb-muted whitespace-nowrap">
                            {formatDateTime(item.updated_at || item.created_at)}
                          </td>
                          <td className="py-2.5 px-3 text-right">
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => handleDownloadAsset(item)}
                                className="p-2 rounded hover:bg-black/5 dark:hover:bg-white/5 wb-accent-text"
                                title="下载文件"
                              >
                                <Download className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDelete(item)}
                                className="p-2 rounded hover:bg-black/5 dark:hover:bg-white/5 wb-muted hover:text-red-600"
                                title="删除文件"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}

                      {bucketItems
                        .filter((bo) => !items.some((i) => i.bucket_key === bo.key))
                        .map((bo) => (
                          <tr key={bo.key} className="hover:bg-black/[0.02] dark:hover:bg-white/[0.02]">
                            <td className="py-2.5 px-3">
                              <div className="flex items-center gap-2.5">
                                <HardDrive className="w-4 h-4 text-sky-600 shrink-0" />
                                <span className="font-mono wb-ink truncate max-w-[240px]">{bo.key}</span>
                              </div>
                            </td>
                            <td className="py-2.5 px-3">{renderStorageLocationBadge('bucket')}</td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums wb-muted">
                              {formatBytes(bo.size)}
                            </td>
                            <td className="py-2.5 px-3 font-mono tabular-nums wb-muted whitespace-nowrap">
                              {formatDateTime(bo.lastModified)}
                            </td>
                            <td className="py-2.5 px-3 text-right">
                              <div className="inline-flex items-center gap-1">
                                <a
                                  href={`/api/bucket/download?key=${encodeURIComponent(bo.key)}`}
                                  className="p-2 rounded hover:bg-black/5 dark:hover:bg-white/5 wb-accent-text"
                                  title="从存储桶下载"
                                >
                                  <Download className="w-3.5 h-3.5" />
                                </a>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteBucketObject(bo.key)}
                                  className="p-2 rounded hover:bg-black/5 dark:hover:bg-white/5 wb-muted hover:text-red-600"
                                  title="从存储桶删除"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

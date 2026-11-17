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
  DbStatusInfo,
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
  const [showD1Guide, setShowD1Guide] = useState(false);

  // D1 HTTP Config
  const [accountId, setAccountId] = useState('');
  const [databaseId, setDatabaseId] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [bindingMsg, setBindingMsg] = useState('');
  const [bindingErr, setBindingErr] = useState('');
  const [savingBind, setSavingBind] = useState(false);

  // Storage Bucket (R2/S3) Config
  const [s3Endpoint, setS3Endpoint] = useState('');
  const [s3Region, setS3Region] = useState('auto');
  const [s3Bucket, setS3Bucket] = useState('');
  const [s3AccessKey, setS3AccessKey] = useState('');
  const [s3SecretKey, setS3SecretKey] = useState('');
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

  const handleBindD1 = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingBind(true);
    setBindingMsg('');
    setBindingErr('');
    try {
      const res = await fetch('/api/db/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId, databaseId, apiToken }),
      });
      const data = (await res.json()) as { message?: string; error?: string };
      if (!res.ok) throw new Error(data.error || 'D1 绑定失败');
      setBindingMsg(data.message || 'Cloudflare D1 绑定成功');
      setApiToken('');
      refresh();
    } catch (err: any) {
      setBindingErr(err?.message || '绑定失败');
    } finally {
      setSavingBind(false);
    }
  };

  const handleUnbindD1 = async () => {
    await fetch('/api/db/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clear: true }),
    });
    setBindingMsg('已解绑远程 D1，切回本地持久化');
    refresh();
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
          <span>存储桶 (R2/S3)</span>
        </span>
      );
    }
    if (loc === 'd1') {
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400 whitespace-nowrap">
          <Database className="w-3 h-3" />
          <span>Cloudflare D1</span>
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-2 sm:p-4">
      <div className="w-full max-w-5xl max-h-[94vh] flex flex-col rounded-xl border wb-border wb-panel shadow-xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b wb-border gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <Database className="w-5 h-5 wb-accent-text shrink-0" />
            <div className="min-w-0">
              <h2 className="text-base sm:text-lg font-semibold wb-ink truncate">
                数据库存储（Cloudflare D1 优先）· 对象存储桶与文件时间记录
              </h2>
              <p className="text-xs wb-muted truncate">
                支持 D1 与 R2/S3 存储桶双通道存储，清晰标注文件存储位置，支持对话历史双向同步
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
                    dbStatus.connected
                      ? 'bg-emerald-600'
                      : dbStatus.d1Bound
                      ? 'bg-red-600'
                      : 'bg-amber-500'
                  }`}
                />
                <span>{dbStatus.connected ? 'D1 已连通' : dbStatus.d1Bound ? '异常' : '本地回退'}</span>
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
                    bucketStatus.connected
                      ? 'bg-emerald-600'
                      : bucketStatus.configured
                      ? 'bg-red-600'
                      : 'bg-slate-400'
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
              <span className="wb-muted ml-2">可将全部对话同步到已绑定的 D1 数据库与对象存储桶，并支持跨设备恢复。</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => onSyncConversations('auto')}
                disabled={syncStatus.status === 'syncing'}
                className="h-9 px-3.5 rounded-lg wb-accent text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                <CloudUpload className="w-3.5 h-3.5" />
                <span>{syncStatus.status === 'syncing' ? '同步中...' : '立即同步历史到 D1/存储桶'}</span>
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

          {/* Cloudflare D1 Binding Form + Detailed HTTP API Guide */}
          <form onSubmit={handleBindD1} className="rounded-xl border wb-border p-4 space-y-3 wb-bg">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold wb-ink">绑定 Cloudflare D1 数据库</h3>
                <p className="text-xs wb-muted">
                  部署到 Cloudflare Pages 时自动使用原生 <code className="font-mono">env.DB</code>；独立运行可在此绑定 D1 HTTP API（绑定时自动初始化 <code className="font-mono">media_assets</code> 与 <code className="font-mono">conversations</code> 表）。
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowD1Guide((v) => !v)}
                  className="h-8 px-3 rounded-lg border wb-border wb-panel text-xs font-medium wb-accent-text inline-flex items-center gap-1"
                >
                  <BookOpen className="w-3.5 h-3.5" />
                  <span>{showD1Guide ? '收起 D1 详细绑定指南' : '查看 D1 HTTP API 详细绑定指南'}</span>
                </button>
                {dbStatus.d1Bound && (
                  <button
                    type="button"
                    onClick={handleUnbindD1}
                    className="h-8 px-3 rounded-lg border wb-border wb-panel text-xs wb-muted hover:wb-ink"
                  >
                    解绑 D1
                  </button>
                )}
              </div>
            </div>

            {showD1Guide && (
              <div className="rounded-lg border wb-border wb-panel p-3.5 text-xs space-y-2 leading-relaxed">
                <div className="font-semibold wb-ink">独立运行绑定 Cloudflare D1 HTTP API 详细步骤指南：</div>
                <ol className="list-decimal pl-5 space-y-1.5 wb-muted">
                  <li>
                    <strong className="wb-ink">获取 Account ID</strong>：登录 Cloudflare Dashboard 首页 → 点击右侧边栏或任意域名的「Overview」，即可复制 32 位 <code className="font-mono">Account ID</code>。
                  </li>
                  <li>
                    <strong className="wb-ink">创建 D1 数据库并获取 Database UUID</strong>：左侧菜单进入「Workers &amp; Pages」→「D1 SQL Database」→ 点击「Create」创建库（例如 <code className="font-mono">bcai-db</code>），进入数据库详情页复制其 UUID（形如 <code className="font-mono">xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx</code>）。
                  </li>
                  <li>
                    <strong className="wb-ink">生成具备 D1 Edit 权限的 API Token</strong>：右上角头像 →「My Profile」→「API Tokens」→「Create Token」→ 选择自定义权限，添加 <code className="font-mono">Account · D1 · Edit</code>（若同时用 Workers AI，建议一并勾选 <code className="font-mono">Account · Workers AI · Edit</code>）。
                  </li>
                  <li>
                    <strong className="wb-ink">自动初始化表结构</strong>：将以上 3 项填入下方输入框并点击「验证并绑定 Cloudflare D1」，系统会自动通过 HTTP API 执行 <code className="font-mono">CREATE TABLE IF NOT EXISTS media_assets ...</code> 与 <code className="font-mono">conversations</code> 建表，无需手动执行 CLI！
                  </li>
                  <li>
                    <strong className="wb-ink">持久化提示</strong>：在 Vercel / Docker / VPS 环境也可以直接将 <code className="font-mono">CF_ACCOUNT_ID</code>、<code className="font-mono">CF_D1_DATABASE_ID</code>、<code className="font-mono">CF_API_TOKEN</code> 写入环境变量，重启后自动生效。
                  </li>
                </ol>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
              <input
                type="text"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                placeholder="Cloudflare Account ID"
                className="h-10 px-3 rounded-lg border wb-border wb-panel text-xs font-mono wb-ink"
              />
              <input
                type="text"
                value={databaseId}
                onChange={(e) => setDatabaseId(e.target.value)}
                placeholder="D1 Database UUID"
                className="h-10 px-3 rounded-lg border wb-border wb-panel text-xs font-mono wb-ink"
              />
              <input
                type="password"
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
                placeholder="CF API Token (含 D1 Edit 权限)"
                className="h-10 px-3 rounded-lg border wb-border wb-panel text-xs font-mono wb-ink"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="submit"
                disabled={savingBind || !accountId.trim() || !databaseId.trim() || !apiToken.trim()}
                className="h-9 px-4 rounded-lg wb-accent text-xs font-medium disabled:opacity-40"
              >
                {savingBind ? '正在验证并自动建表...' : '验证并绑定 Cloudflare D1'}
              </button>
              {bindingMsg && <span className="text-xs text-emerald-600 dark:text-emerald-400">{bindingMsg}</span>}
              {bindingErr && <span className="text-xs text-red-600 dark:text-red-400">{bindingErr}</span>}
            </div>
          </form>

          {/* Storage Bucket Binding Form (Cloudflare R2 / S3) */}
          <form onSubmit={handleBindBucket} className="rounded-xl border wb-border p-4 space-y-3 wb-bg">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold wb-ink">绑定对象存储桶（Cloudflare R2 / S3 兼容）</h3>
                <p className="text-xs wb-muted">
                  R2 Endpoint 示例：<code className="font-mono">https://&lt;ACCOUNT_ID&gt;.r2.cloudflarestorage.com</code>，Region 填 <code className="font-mono">auto</code>；支持图片、代码压缩包与会话历史云端同步。
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

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
              <input
                type="text"
                value={s3Endpoint}
                onChange={(e) => setS3Endpoint(e.target.value)}
                placeholder="Endpoint (https://...)"
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
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={s3Region}
                  onChange={(e) => setS3Region(e.target.value)}
                  placeholder="Region (auto)"
                  className="w-24 h-9 px-2.5 rounded-lg border wb-border wb-panel text-xs font-mono wb-ink"
                />
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
                  <option value="db">上传目标：D1 数据库</option>
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

                      {/* Direct Bucket Objects not indexed in DB table */}
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

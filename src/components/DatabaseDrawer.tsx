import React, { useEffect, useState } from 'react';
import { Database, Download, FileText, Image as ImageIcon, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { SavedAsset } from '../types';
import { formatBytes, formatDateTime, uid } from '../utils/format';

interface DatabaseDrawerProps {
  open: boolean;
  onClose: () => void;
  accessPassword?: string;
}

export const DatabaseDrawer: React.FC<DatabaseDrawerProps> = ({ open, onClose, accessPassword }) => {
  const [status, setStatus] = useState<{
    mode: string;
    connected: boolean;
    d1Bound: boolean;
    label: string;
    itemCount?: number;
  } | null>(null);
  const [items, setItems] = useState<SavedAsset[]>([]);
  const [filterType, setFilterType] = useState<'all' | 'image' | 'file'>('all');
  const [loading, setLoading] = useState(false);

  const [accountId, setAccountId] = useState('');
  const [databaseId, setDatabaseId] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [bindingMsg, setBindingMsg] = useState('');
  const [bindingErr, setBindingErr] = useState('');
  const [savingBind, setSavingBind] = useState(false);

  const headers = () => {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (accessPassword) h['x-access-password'] = encodeURIComponent(accessPassword);
    return h;
  };

  const refresh = async () => {
    setLoading(true);
    try {
      const [stRes, listRes] = await Promise.all([
        fetch('/api/db/status', { headers: headers() }),
        fetch(`/api/db/items${filterType === 'all' ? '' : `?type=${filterType}`}`, { headers: headers() }),
      ]);
      if (stRes.ok) setStatus(await stRes.json());
      if (listRes.ok) {
        const listData = (await listRes.json()) as { items?: SavedAsset[] };
        setItems(listData.items || []);
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
        headers: headers(),
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
      headers: headers(),
      body: JSON.stringify({ clear: true }),
    });
    setBindingMsg('已切换回本地持久化存储');
    refresh();
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const isImage = file.type.startsWith('image/');
    const reader = new FileReader();
    reader.onload = async () => {
      const contentData = String(reader.result || '');
      await fetch('/api/db/items', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          id: uid(),
          type: isImage ? 'image' : 'file',
          name: file.name,
          mimeType: file.type || 'text/plain',
          sizeBytes: file.size,
          contentData,
        }),
      });
      refresh();
    };
    if (isImage) reader.readAsDataURL(file);
    else reader.readAsText(file);
    e.target.value = '';
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/db/items/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: headers(),
    });
    refresh();
  };

  const handleDownloadAsset = (item: SavedAsset) => {
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
      <div className="w-full max-w-4xl max-h-[90vh] flex flex-col rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-2.5">
            <Database className="w-5 h-5 text-blue-600" />
            <div>
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                数据库存储（Cloudflare D1 优先）与文件时间记录
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {status ? `${status.label} · 当前记录数 ${status.itemCount ?? items.length}` : '正在读取数据库状态...'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-9 h-9 rounded-lg flex items-center justify-center text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Cloudflare D1 Binding Form */}
          <form onSubmit={handleBindD1} className="rounded-xl border border-slate-200 dark:border-slate-800 p-4 space-y-3 bg-slate-50/70 dark:bg-slate-950/50">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  绑定 Cloudflare D1 数据库
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  部署到 Cloudflare Pages 时自动使用原生 <code className="font-mono">env.DB</code>；独立运行可在此绑定 D1 HTTP API（绑定时自动初始化 <code className="font-mono">media_assets</code> 表）。
                </p>
              </div>
              {status?.d1Bound && (
                <button
                  type="button"
                  onClick={handleUnbindD1}
                  className="h-8 px-3 rounded-lg border border-slate-200 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-900"
                >
                  解绑 D1（切回本地）
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
              <input
                type="text"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                placeholder="Cloudflare Account ID"
                className="h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-xs font-mono"
              />
              <input
                type="text"
                value={databaseId}
                onChange={(e) => setDatabaseId(e.target.value)}
                placeholder="D1 Database UUID"
                className="h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-xs font-mono"
              />
              <input
                type="password"
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
                placeholder="CF API Token (含 D1 Edit 权限)"
                className="h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-xs font-mono"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="submit"
                disabled={savingBind || !accountId.trim() || !databaseId.trim() || !apiToken.trim()}
                className="h-9 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium disabled:opacity-40"
              >
                {savingBind ? '正在验证并建表...' : '验证并绑定 Cloudflare D1'}
              </button>
              {bindingMsg && <span className="text-xs text-emerald-600 dark:text-emerald-400">{bindingMsg}</span>}
              {bindingErr && <span className="text-xs text-red-600 dark:text-red-400">{bindingErr}</span>}
            </div>
          </form>

          {/* Saved Images & Files Table */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800">
                {(['all', 'image', 'file'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setFilterType(t)}
                    className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                      filterType === t
                        ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                        : 'text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    {t === 'all' ? '全部资产' : t === 'image' ? '已存图片' : '代码与文件'}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <label className="h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 cursor-pointer">
                  <Upload className="w-3.5 h-3.5" />
                  <span>上传图片或文件入库</span>
                  <input type="file" onChange={handleFileUpload} className="hidden" />
                </label>
                <button
                  type="button"
                  onClick={refresh}
                  className="h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-800 text-xs hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                  <span>刷新</span>
                </button>
              </div>
            </div>

            {items.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-200 dark:border-slate-800 py-10 text-center text-xs text-slate-500">
                暂无已保存的图片或文件。可在绘图区点击“存至数据库”、在代码回复块点击“存至文件库”，或点击右上角上传。
              </div>
            ) : (
              <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                      <tr>
                        <th className="py-2.5 px-3 font-medium">名称 / 预览</th>
                        <th className="py-2.5 px-3 font-medium">类型</th>
                        <th className="py-2.5 px-3 font-medium text-right">大小</th>
                        <th className="py-2.5 px-3 font-medium">保存时间</th>
                        <th className="py-2.5 px-3 font-medium text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                      {items.map((item) => (
                        <tr key={item.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                          <td className="py-2.5 px-3">
                            <div className="flex items-center gap-2.5">
                              {item.type === 'image' && item.content_data.startsWith('data:') ? (
                                <img
                                  src={item.content_data}
                                  alt={item.name}
                                  className="w-9 h-9 rounded object-cover border border-slate-200 dark:border-slate-700 shrink-0"
                                />
                              ) : item.type === 'image' ? (
                                <ImageIcon className="w-4 h-4 text-slate-400 shrink-0" />
                              ) : (
                                <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                              )}
                              <div className="min-w-0">
                                <div className="font-medium text-slate-900 dark:text-slate-100 truncate max-w-[260px]">
                                  {item.name}
                                </div>
                                {item.prompt && (
                                  <div className="text-[11px] text-slate-500 truncate max-w-[260px]">
                                    {item.prompt}
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="py-2.5 px-3 text-slate-600 dark:text-slate-400">
                            {item.type === 'image' ? '图像' : '文件'}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-600 dark:text-slate-400">
                            {formatBytes(item.size_bytes)}
                          </td>
                          <td className="py-2.5 px-3 font-mono tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
                            {formatDateTime(item.updated_at || item.created_at)}
                          </td>
                          <td className="py-2.5 px-3 text-right">
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => handleDownloadAsset(item)}
                                className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-blue-600 dark:text-blue-400"
                                title="下载"
                              >
                                <Download className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDelete(item.id)}
                                className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 hover:text-red-600"
                                title="删除"
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

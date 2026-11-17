import React, { useEffect, useState } from 'react';
import { Cloud, Globe, Mail, Plug, Plus, RefreshCw, Rocket, Trash2 } from 'lucide-react';
import { ConnectorCategory, ConnectorItem } from '../types';
import { uid } from '../utils/format';
import { StatusIndicator } from './StatusIndicator';

interface ConnectorsWorkspaceProps {
  onShowToast: (msg: string) => void;
}

const PRESETS: Array<{
  category: ConnectorCategory;
  presetKey: string;
  name: string;
  defaultEndpoint: string;
  placeholderUser: string;
  placeholderToken: string;
}> = [
  {
    category: 'cloud-disk',
    presetKey: 'alist',
    name: 'Alist / 阿里云盘聚合网盘',
    defaultEndpoint: 'https://alist.example.com',
    placeholderUser: '可选账号/目录路径',
    placeholderToken: 'Alist Token / 访问密钥',
  },
  {
    category: 'cloud-disk',
    presetKey: 'webdav',
    name: 'WebDAV 网盘（坚果云 / Nextcloud / 123云盘）',
    defaultEndpoint: 'https://dav.jianguoyun.com/dav/',
    placeholderUser: 'WebDAV 账号邮箱',
    placeholderToken: 'WebDAV 应用密码',
  },
  {
    category: 'cloud-disk',
    presetKey: 'onedrive',
    name: 'Microsoft OneDrive Graph API',
    defaultEndpoint: 'https://graph.microsoft.com/v1.0/me/drive',
    placeholderUser: 'Drive ID (可选)',
    placeholderToken: 'OAuth Access Token',
  },
  {
    category: 'cloud-disk',
    presetKey: 'gdrive',
    name: 'Google Drive API',
    defaultEndpoint: 'https://www.googleapis.com/drive/v3/about?fields=user',
    placeholderUser: 'Folder ID (可选)',
    placeholderToken: 'OAuth Bearer Token',
  },
  {
    category: 'email',
    presetKey: 'resend',
    name: 'Resend 邮件发送服务',
    defaultEndpoint: 'https://api.resend.com/domains',
    placeholderUser: '发件人邮箱 (noreply@example.com)',
    placeholderToken: 'Resend API Key (re_...)',
  },
  {
    category: 'email',
    presetKey: 'smtp-webhook',
    name: '通用邮箱通知 / SMTP Webhook',
    defaultEndpoint: 'https://mail-relay.example.com/health',
    placeholderUser: 'SMTP 用户名 / 邮箱账号',
    placeholderToken: '授权码 / Bearer Token',
  },
  {
    category: 'deploy',
    presetKey: 'cloudflare',
    name: 'Cloudflare Pages / Workers API',
    defaultEndpoint: 'https://api.cloudflare.com/client/v4/user/tokens/verify',
    placeholderUser: 'Account ID',
    placeholderToken: 'CF API Token',
  },
  {
    category: 'deploy',
    presetKey: 'vercel',
    name: 'Vercel 部署平台',
    defaultEndpoint: 'https://api.vercel.com/v2/user',
    placeholderUser: 'Project ID / Team ID',
    placeholderToken: 'Vercel Personal Token',
  },
  {
    category: 'deploy',
    presetKey: 'netlify',
    name: 'Netlify 部署平台',
    defaultEndpoint: 'https://api.netlify.com/api/v1/user',
    placeholderUser: 'Site ID',
    placeholderToken: 'Netlify Access Token',
  },
  {
    category: 'other',
    presetKey: 'webhook',
    name: '其他自定义 Webhook / MCP / API',
    defaultEndpoint: 'https://api.example.com/health',
    placeholderUser: '标识 / App ID',
    placeholderToken: 'Bearer Token / Secret',
  },
];

const CATEGORY_META: Record<ConnectorCategory, { label: string; Icon: React.ComponentType<{ className?: string }> }> = {
  'cloud-disk': { label: '主流网盘', Icon: Cloud },
  email: { label: '邮箱服务', Icon: Mail },
  deploy: { label: '部署平台', Icon: Rocket },
  other: { label: '其他连接器', Icon: Globe },
};

export const ConnectorsWorkspace: React.FC<ConnectorsWorkspaceProps> = ({ onShowToast }) => {
  const [items, setItems] = useState<ConnectorItem[]>([]);
  const [activeCategory, setActiveCategory] = useState<ConnectorCategory | 'all'>('all');
  const [editing, setEditing] = useState(false);

  const [category, setCategory] = useState<ConnectorCategory>('cloud-disk');
  const [presetKey, setPresetKey] = useState('alist');
  const [name, setName] = useState('Alist / 阿里云盘聚合网盘');
  const [endpoint, setEndpoint] = useState('https://alist.example.com');
  const [usernameOrId, setUsernameOrId] = useState('');
  const [secretToken, setSecretToken] = useState('');
  const [extraConfig, setExtraConfig] = useState('');

  const loadConnectors = async () => {
    try {
      const r = await fetch('/api/connectors');
      if (r.ok) {
        const d = (await r.json()) as { items?: ConnectorItem[] };
        setItems(d.items || []);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    loadConnectors();
  }, []);

  const applyPreset = (pKey: string) => {
    const p = PRESETS.find((x) => x.presetKey === pKey);
    if (!p) return;
    setCategory(p.category);
    setPresetKey(p.presetKey);
    setName(p.name);
    setEndpoint(p.defaultEndpoint);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const payload: ConnectorItem = {
      id: `conn_${uid()}`,
      category,
      presetKey,
      name: name.trim(),
      endpoint: endpoint.trim(),
      usernameOrId: usernameOrId.trim(),
      secretToken: secretToken.trim(),
      extraConfig: extraConfig.trim(),
      status: 'unconfigured',
      updatedAt: new Date().toISOString(),
    };
    const r = await fetch('/api/connectors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (r.ok) {
      setEditing(false);
      setSecretToken('');
      setUsernameOrId('');
      setExtraConfig('');
      onShowToast(`已保存连接器：${payload.name}`);
      await loadConnectors();
      handleProbe(payload);
    }
  };

  const handleProbe = async (item: ConnectorItem) => {
    setItems((prev) => prev.map((x) => (x.id === item.id ? { ...x, status: 'checking', statusMessage: '探测中...' } : x)));
    try {
      const r = await fetch('/api/connectors/probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(item),
      });
      const res = (await r.json()) as { status: ConnectorItem['status']; latencyMs?: number; message?: string };
      const updated: ConnectorItem = {
        ...item,
        status: res.status || 'error',
        latencyMs: res.latencyMs,
        statusMessage: res.message,
        checkedAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      };
      setItems((prev) => prev.map((x) => (x.id === item.id ? updated : x)));
      await fetch('/api/connectors', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(updated),
      });
    } catch {
      setItems((prev) => prev.map((x) => (x.id === item.id ? { ...x, status: 'error', statusMessage: '请求失败' } : x)));
    }
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/connectors/${encodeURIComponent(id)}`, { method: 'DELETE' });
    setItems((prev) => prev.filter((x) => x.id !== id));
    onShowToast('已删除连接器');
  };

  const visibleItems = activeCategory === 'all' ? items : items.filter((i) => i.category === activeCategory);
  const currentPreset = PRESETS.find((p) => p.presetKey === presetKey) || PRESETS[0];

  return (
    <div className="flex-1 overflow-y-auto px-3 sm:px-5 py-4 sm:py-6">
      <div className="max-w-5xl mx-auto space-y-5">
        {/* Header Card */}
        <div className="rounded-xl border wb-border wb-panel p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-lg wb-tint flex items-center justify-center shrink-0">
              <Plug className="w-5 h-5 wb-accent-text" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold wb-ink">连接器中心（网盘 · 邮箱 · 部署平台 · 其他）</h2>
              <p className="text-xs wb-muted">
                统一管理外部服务凭证与真实状态探活，支持 WebDAV/Alist/OneDrive/Google Drive、Resend/SMTP 邮箱及 Cloudflare/Vercel/Netlify 平台。
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className="h-10 px-4 rounded-lg wb-accent text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            <span>{editing ? '收起添加表单' : '接入新连接器'}</span>
          </button>
        </div>

        {/* Add Form */}
        {editing && (
          <form onSubmit={handleSave} className="rounded-xl border wb-border wb-panel p-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <label className="flex flex-col gap-1 text-xs wb-muted">
                <span>快速预设模板</span>
                <select
                  value={presetKey}
                  onChange={(e) => applyPreset(e.target.value)}
                  className="h-10 px-2.5 rounded-lg border wb-border wb-bg text-xs sm:text-sm wb-ink"
                >
                  {PRESETS.map((p) => (
                    <option key={p.presetKey} value={p.presetKey}>
                      [{CATEGORY_META[p.category].label}] {p.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1 text-xs wb-muted">
                <span>连接器分类</span>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as ConnectorCategory)}
                  className="h-10 px-2.5 rounded-lg border wb-border wb-bg text-xs sm:text-sm wb-ink"
                >
                  <option value="cloud-disk">主流网盘</option>
                  <option value="email">邮箱服务</option>
                  <option value="deploy">部署平台</option>
                  <option value="other">其他扩展</option>
                </select>
              </label>

              <label className="flex flex-col gap-1 text-xs wb-muted">
                <span>连接器名称</span>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="h-10 px-3 rounded-lg border wb-border wb-bg text-xs sm:text-sm wb-ink"
                />
              </label>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <label className="flex flex-col gap-1 text-xs wb-muted">
                <span>API / 端点地址 URL</span>
                <input
                  type="text"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="https://..."
                  className="h-10 px-3 rounded-lg border wb-border wb-bg text-xs font-mono wb-ink"
                />
              </label>

              <label className="flex flex-col gap-1 text-xs wb-muted">
                <span>账号 / ID（可选）</span>
                <input
                  type="text"
                  value={usernameOrId}
                  onChange={(e) => setUsernameOrId(e.target.value)}
                  placeholder={currentPreset.placeholderUser}
                  className="h-10 px-3 rounded-lg border wb-border wb-bg text-xs wb-ink"
                />
              </label>

              <label className="flex flex-col gap-1 text-xs wb-muted">
                <span>Token / 密码 / API Key</span>
                <input
                  type="password"
                  value={secretToken}
                  onChange={(e) => setSecretToken(e.target.value)}
                  placeholder={currentPreset.placeholderToken}
                  className="h-10 px-3 rounded-lg border wb-border wb-bg text-xs font-mono wb-ink"
                />
              </label>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <input
                type="text"
                value={extraConfig}
                onChange={(e) => setExtraConfig(e.target.value)}
                placeholder="备注或附加配置（如默认存储目录、项目别名等）"
                className="flex-1 min-w-[220px] h-10 px-3 rounded-lg border wb-border wb-bg text-xs wb-ink"
              />
              <button type="submit" className="h-10 px-5 rounded-lg wb-accent text-xs font-medium whitespace-nowrap">
                保存并检测连接
              </button>
            </div>
          </form>
        )}

        {/* Filter Tabs */}
        <div className="flex flex-wrap gap-1.5 p-1 rounded-xl border wb-border wb-panel w-fit max-w-full overflow-x-auto no-scrollbar">
          <button
            type="button"
            onClick={() => setActiveCategory('all')}
            className={`h-9 px-3 rounded-lg text-xs font-medium whitespace-nowrap ${
              activeCategory === 'all' ? 'wb-tint wb-accent-text' : 'wb-muted'
            }`}
          >
            全部 ({items.length})
          </button>
          {(Object.keys(CATEGORY_META) as ConnectorCategory[]).map((cat) => {
            const Meta = CATEGORY_META[cat];
            const Icon = Meta.Icon;
            const count = items.filter((i) => i.category === cat).length;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setActiveCategory(cat)}
                className={`h-9 px-3 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap ${
                  activeCategory === cat ? 'wb-tint wb-accent-text' : 'wb-muted'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>
                  {Meta.label} ({count})
                </span>
              </button>
            );
          })}
        </div>

        {/* List */}
        {visibleItems.length === 0 ? (
          <div className="rounded-xl border border-dashed wb-border wb-panel p-8 text-center text-xs wb-muted space-y-2">
            <p>暂无已接入的连接器。点击右上角“接入新连接器”即可添加阿里云盘/Alist、WebDAV、OneDrive、Resend 邮箱或 Vercel/Cloudflare 令牌。</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {visibleItems.map((item) => {
              const Meta = CATEGORY_META[item.category];
              const Icon = Meta.Icon;
              return (
                <div key={item.id} className="rounded-xl border wb-border wb-panel p-4 flex flex-col justify-between gap-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2.5 min-w-0">
                      <div className="w-9 h-9 rounded-lg wb-code flex items-center justify-center shrink-0 mt-0.5">
                        <Icon className="w-4 h-4 wb-accent-text" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold wb-ink truncate">{item.name}</div>
                        <div className="text-[11px] wb-muted mt-0.5 truncate font-mono">
                          {Meta.label} · {item.endpoint || '默认接口'}
                        </div>
                      </div>
                    </div>
                    <StatusIndicator status={item.status} latencyMs={item.latencyMs} title={item.statusMessage} />
                  </div>

                  <div className="text-xs wb-muted space-y-0.5">
                    {item.usernameOrId && <div className="truncate">账号/标识：{item.usernameOrId}</div>}
                    {item.statusMessage && <div className="truncate">探测详情：{item.statusMessage}</div>}
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-2 border-t wb-border">
                    <button
                      type="button"
                      onClick={() => handleProbe(item)}
                      className="h-8 px-3 rounded-lg border wb-border text-xs font-medium wb-ink hover:opacity-80 inline-flex items-center gap-1"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>检测连通</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(item.id)}
                      className="h-8 px-2.5 rounded-lg border wb-border text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 inline-flex items-center gap-1"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>移除</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

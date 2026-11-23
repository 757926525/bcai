import React, { useEffect, useState } from 'react';
import {
  BookOpen,
  ExternalLink,
  Laptop,
  Lock,
  Moon,
  Palette,
  Plus,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Sun,
  Trash2,
  X,
} from 'lucide-react';
import { PROVIDER_GUIDES, WORKBENCH_THEMES } from '../data/models';
import {
  ExternalProvider,
  LayoutMode,
  ProviderStatusInfo,
  ProviderType,
  PublicConfig,
  ThemeId,
} from '../types';
import { uid } from '../utils/format';
import { StatusIndicator } from './StatusIndicator';

interface SettingsModalProps {
  open: boolean;
  initialTab?: 'providers' | 'guides' | 'appearance';
  onClose: () => void;
  isAdmin: boolean;
  requireLoginGate: boolean;
  onToggleLoginGate: (enabled: boolean, initialPassword?: string) => Promise<void>;
  onLockGateNow?: () => Promise<void> | void;
  providers: ExternalProvider[];
  providerStatuses: Record<string, ProviderStatusInfo>;
  publicConfig: PublicConfig | null;
  temperature: number;
  onChangeTemperature: (t: number) => void;
  themeId: ThemeId;
  onChangeTheme: (id: ThemeId) => void;
  dark: boolean;
  onToggleDark: () => void;
  layoutMode: LayoutMode;
  onChangeLayoutMode: (m: LayoutMode) => void;
  onSaveProvider: (provider: ExternalProvider) => void;
  onDeleteProvider: (id: string) => void;
  onProbeProvider: (provider: ExternalProvider) => Promise<void>;
  onProbeAll: () => void;
  onClearAllConversations: () => void;
}

const DEFAULT_BASE_BY_TYPE: Record<ProviderType, string> = {
  'workers-ai': 'https://api.cloudflare.com/client/v4',
  gemini: 'https://generativelanguage.googleapis.com',
  deepseek: 'https://api.deepseek.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  'openai-compatible': 'https://api.openai.com/v1',
};

export const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  initialTab = 'appearance',
  onClose,
  isAdmin,
  requireLoginGate,
  onToggleLoginGate,
  onLockGateNow,
  providers,
  providerStatuses,
  publicConfig,
  temperature,
  onChangeTemperature,
  themeId,
  onChangeTheme,
  dark,
  onToggleDark,
  layoutMode,
  onChangeLayoutMode,
  onSaveProvider,
  onDeleteProvider,
  onProbeProvider,
  onProbeAll,
  onClearAllConversations,
}) => {
  const [tab, setTab] = useState<'providers' | 'guides' | 'appearance'>(initialTab);
  const [togglingGate, setTogglingGate] = useState(false);
  const [gateInitPw, setGateInitPw] = useState('');
  const [gateSwitchError, setGateSwitchError] = useState('');

  useEffect(() => {
    if (open) {
      setGateSwitchError('');
      if (initialTab === 'providers' && !isAdmin) setTab('guides');
      else setTab(initialTab);
    }
  }, [open, initialTab, isAdmin]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [providerType, setProviderType] = useState<ProviderType>('openai-compatible');
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_BY_TYPE['openai-compatible']);
  const [apiKey, setApiKey] = useState('');
  const [accountId, setAccountId] = useState('');
  const [modelsText, setModelsText] = useState('gpt-4o-mini');
  const [directStream, setDirectStream] = useState(true);
  const [isFreeTier, setIsFreeTier] = useState(true);
  const [quotaNote, setQuotaNote] = useState('自定义端点 / 免费额度');

  if (!open) return null;

  const startNew = () => {
    setEditingId('__new__');
    setName('我的 OpenAI 兼容端点');
    setProviderType('openai-compatible');
    setBaseUrl('https://api.groq.com/openai/v1');
    setApiKey('');
    setAccountId('');
    setModelsText('llama-3.3-70b-versatile\ndeepseek-r1-distill-llama-70b');
    setDirectStream(true);
    setIsFreeTier(true);
    setQuotaNote('免费层级 / 自定义限额');
  };

  const startEdit = (p: ExternalProvider) => {
    setEditingId(p.id);
    setName(p.name);
    setProviderType(p.providerType);
    setBaseUrl(p.baseUrl);
    setApiKey(p.apiKey);
    setAccountId(p.accountId || '');
    setModelsText(p.models.join('\n'));
    setDirectStream(p.directStream);
    setIsFreeTier(p.isFreeTier);
    setQuotaNote(p.quotaNote);
  };

  const handleSubmitProvider = (e: React.FormEvent) => {
    e.preventDefault();
    const models = modelsText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!name.trim() || models.length === 0) return;

    const existing = providers.find((p) => p.id === editingId);
    const next: ExternalProvider = {
      id: editingId === '__new__' || !editingId ? `custom-${uid()}` : editingId,
      name: name.trim(),
      providerType,
      source: existing?.source === 'env' && !apiKey.trim() && !accountId.trim() ? 'env' : 'custom',
      baseUrl: baseUrl.trim() || DEFAULT_BASE_BY_TYPE[providerType],
      apiKey: apiKey.trim(),
      accountId: accountId.trim(),
      models,
      directStream,
      isFreeTier,
      quotaNote: quotaNote.trim() || '自定义端点',
      enabled: true,
    };
    onSaveProvider(next);
    setEditingId(null);
    onProbeProvider(next);
  };

  const hasEnvBackend = (p: ExternalProvider): boolean => {
    if (!publicConfig) return false;
    if (p.providerType === 'workers-ai') return publicConfig.envProviders.workersAi;
    if (p.providerType === 'gemini') return publicConfig.envProviders.gemini;
    if (p.providerType === 'deepseek') return publicConfig.envProviders.deepseek;
    if (p.providerType === 'groq') return publicConfig.envProviders.groq;
    if (p.providerType === 'openrouter') return publicConfig.envProviders.openrouter;
    return publicConfig.envProviders.openai;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-2 sm:p-4">
      <div className="w-full max-w-4xl max-h-[92vh] flex flex-col rounded-xl border wb-border wb-panel shadow-xl overflow-hidden">
        <div className="flex flex-wrap items-center justify-between px-4 sm:px-6 py-3.5 border-b wb-border gap-3">
          <div className="flex flex-wrap items-center gap-3 min-w-0">
            <h2 className="text-base sm:text-lg font-semibold wb-ink whitespace-nowrap">
              {isAdmin ? '设置、主题与模型接入中心' : '主题外观与免费模型指南'}
            </h2>
            <div className="flex items-center gap-1 p-1 rounded-lg wb-bg border wb-border overflow-x-auto no-scrollbar max-w-full">
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => setTab('providers')}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                    tab === 'providers' ? 'wb-panel wb-ink shadow-sm' : 'wb-muted'
                  }`}
                >
                  外接 API 与模型管理
                </button>
              )}
              <button
                type="button"
                onClick={() => setTab('appearance')}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors inline-flex items-center gap-1 whitespace-nowrap ${
                  tab === 'appearance' ? 'wb-panel wb-ink shadow-sm' : 'wb-muted'
                }`}
              >
                <Palette className="w-3.5 h-3.5" />
                <span>主题与布局 (6款)</span>
              </button>
              <button
                type="button"
                onClick={() => setTab('guides')}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors inline-flex items-center gap-1 whitespace-nowrap ${
                  tab === 'guides' ? 'wb-panel wb-ink shadow-sm' : 'wb-muted'
                }`}
              >
                <BookOpen className="w-3.5 h-3.5" />
                <span>免费模型与接入指南</span>
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-9 h-9 rounded-lg flex items-center justify-center wb-muted hover:bg-black/5 dark:hover:bg-white/5 shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">
          {tab === 'appearance' ? (
            <div className="space-y-5">
              {/* Quick Display & Layout Switchers (Moved here from mobile header) */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="rounded-xl border wb-border wb-bg p-4 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold wb-ink">夜间 / 浅色模式</div>
                    <p className="text-xs wb-muted mt-0.5">切换工作台浅色护眼或深色夜间模式</p>
                  </div>
                  <button
                    type="button"
                    onClick={onToggleDark}
                    className="h-9 px-3.5 rounded-lg border wb-border wb-panel text-xs font-medium wb-ink inline-flex items-center gap-1.5 shrink-0 hover:opacity-85"
                  >
                    {dark ? <Sun className="w-3.5 h-3.5 text-amber-500" /> : <Moon className="w-3.5 h-3.5" />}
                    <span>{dark ? '夜间 · 切浅色' : '浅色 · 切夜间'}</span>
                  </button>
                </div>

                <div className="rounded-xl border wb-border wb-bg p-4 flex flex-wrap items-center justify-between gap-2.5">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold wb-ink">手机 / 电脑界面切换</div>
                    <p className="text-xs wb-muted mt-0.5">支持自适应、手机触控或电脑宽屏</p>
                  </div>
                  <div className="flex items-center gap-1 p-1 rounded-lg wb-panel border wb-border shrink-0">
                    {(
                      [
                        ['auto', '自适应', Laptop],
                        ['mobile', '手机', Smartphone],
                        ['desktop', '电脑', Laptop],
                      ] as Array<[LayoutMode, string, React.ComponentType<{ className?: string }>]>
                    ).map(([k, label, Icon]) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => onChangeLayoutMode(k)}
                        className={`h-8 px-2.5 rounded-md text-xs font-medium inline-flex items-center gap-1 ${
                          layoutMode === k ? 'wb-accent' : 'wb-muted'
                        }`}
                      >
                        <Icon className="w-3.5 h-3.5" />
                        <span>{label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Theme Grid */}
              <div className="space-y-3">
                <div>
                  <h3 className="text-sm font-semibold wb-ink">工作台配色主题（6 款 · 含 CF 原生同款）</h3>
                  <p className="text-xs wb-muted">所有主题均支持浅色 / 深色双模式即时切换</p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {WORKBENCH_THEMES.map((t) => {
                    const active = themeId === t.id;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => onChangeTheme(t.id)}
                        className={`text-left p-3.5 rounded-xl border transition-colors space-y-2 ${
                          active ? 'border-blue-600 wb-tint' : 'wb-border wb-bg hover:opacity-90'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold wb-ink">{t.name}</span>
                          <div className="flex items-center gap-1 shrink-0">
                            {t.previewSwatches.map((hex, i) => (
                              <span
                                key={i}
                                className="w-3.5 h-3.5 rounded-full border border-black/15"
                                style={{ backgroundColor: hex }}
                              />
                            ))}
                          </div>
                        </div>
                        <p className="text-xs wb-muted leading-snug">{t.description}</p>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : tab === 'providers' && isAdmin ? (
            <>
              {/* Site-wide Admin Login Gate Toggle */}
              <div className="rounded-xl border wb-border wb-bg p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="space-y-1 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <ShieldCheck className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
                      <span className="text-sm font-semibold wb-ink">全站访问限制开关（管理员登录门禁）</span>
                      <span
                        className={`px-2 py-0.5 rounded-md text-[11px] font-medium ${
                          requireLoginGate
                            ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30'
                            : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30'
                        }`}
                      >
                        {requireLoginGate ? '已开启全站拦截' : '已关闭（免登录开放）'}
                      </span>
                    </div>
                    <p className="text-xs wb-muted leading-relaxed">
                      打开后，未登录的访客将被全屏管理员登录界面挡住主界面（同时后端严格拦截未授权对话、绘图、模型探测与部署下载接口），仅管理员登录后方可使用全部功能。
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {requireLoginGate && onLockGateNow && (
                      <button
                        type="button"
                        onClick={async () => {
                          await onLockGateNow();
                          onClose();
                        }}
                        className="h-9 px-3 rounded-lg border border-amber-400/60 bg-amber-500/10 text-xs font-medium text-amber-700 dark:text-amber-300 hover:bg-amber-500/20"
                      >
                        立即锁屏验证
                      </button>
                    )}

                    <button
                      type="button"
                      role="switch"
                      aria-checked={requireLoginGate}
                      disabled={togglingGate}
                      onClick={async () => {
                        setGateSwitchError('');
                        if (!requireLoginGate && !publicConfig?.hasAdminPassword && gateInitPw.trim().length < 4) {
                          setGateSwitchError('开启前请先设置至少 4 位管理员密码（或在环境变量中配置 ACCESS_PASSWORD），避免锁死无法解锁。');
                          return;
                        }
                        setTogglingGate(true);
                        try {
                          await onToggleLoginGate(
                            !requireLoginGate,
                            !requireLoginGate && gateInitPw.trim() ? gateInitPw.trim() : undefined
                          );
                          setGateInitPw('');
                        } catch (err: any) {
                          setGateSwitchError(err?.message || '切换全站门禁失败');
                        } finally {
                          setTogglingGate(false);
                        }
                      }}
                      className={`h-9 px-3.5 rounded-lg border text-xs font-medium inline-flex items-center gap-2 transition-colors shrink-0 ${
                        requireLoginGate
                          ? 'bg-blue-600 border-blue-600 text-white hover:bg-blue-700'
                          : 'wb-panel wb-border wb-ink hover:opacity-80'
                      } disabled:opacity-50`}
                    >
                      <Lock className="w-3.5 h-3.5" />
                      <span>
                        {togglingGate
                          ? '切换中...'
                          : requireLoginGate
                          ? '已开启 · 点击关闭'
                          : '已关闭 · 点击开启'}
                      </span>
                    </button>
                  </div>
                </div>

                {!requireLoginGate && !publicConfig?.hasAdminPassword && (
                  <div className="pt-2 border-t wb-border flex flex-col sm:flex-row sm:items-center gap-2">
                    <span className="text-xs wb-muted shrink-0">首次开启需同步设定管理员密码：</span>
                    <input
                      type="password"
                      value={gateInitPw}
                      onChange={(e) => setGateInitPw(e.target.value)}
                      placeholder="输入至少 4 位管理员解锁密码"
                      className="flex-1 h-9 px-3 rounded-lg border wb-border wb-panel text-xs wb-ink focus:outline-none"
                    />
                  </div>
                )}

                {gateSwitchError && (
                  <div className="text-xs text-red-600 dark:text-red-400">{gateSwitchError}</div>
                )}
              </div>

              {/* Header controls */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs wb-muted">
                  支持后端环境变量注入（<code className="font-mono">.env</code> / Cloudflare Secrets）与前端本地保存两种方式，保存后立即同步到大模型选区并可实时探测连接状态。
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={onProbeAll}
                    className="h-9 px-3 rounded-lg border wb-border text-xs font-medium wb-ink hover:opacity-80 inline-flex items-center gap-1.5"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>全部检测状态</span>
                  </button>
                  <button
                    type="button"
                    onClick={startNew}
                    className="h-9 px-3.5 rounded-lg wb-accent text-xs font-medium inline-flex items-center gap-1.5"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>新增外接 API</span>
                  </button>
                </div>
              </div>

              {/* Editor Form */}
              {editingId && (
                <form
                  onSubmit={handleSubmitProvider}
                  className="rounded-xl border border-blue-300 dark:border-blue-900 wb-tint p-4 space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold wb-ink">
                      {editingId === '__new__' ? '添加外接 API 端点' : `编辑配置：${name}`}
                    </span>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="text-xs wb-muted hover:wb-ink"
                    >
                      取消
                    </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <label className="flex flex-col gap-1 text-xs wb-muted">
                      <span>显示名称</span>
                      <input
                        type="text"
                        required
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="h-9 px-2.5 rounded-lg border wb-border wb-panel wb-ink"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs wb-muted">
                      <span>协议类型</span>
                      <select
                        value={providerType}
                        onChange={(e) => {
                          const t = e.target.value as ProviderType;
                          setProviderType(t);
                          setBaseUrl(DEFAULT_BASE_BY_TYPE[t]);
                          setDirectStream(t !== 'gemini' && t !== 'workers-ai');
                        }}
                        className="h-9 px-2.5 rounded-lg border wb-border wb-panel wb-ink"
                      >
                        <option value="openai-compatible">OpenAI 兼容端点</option>
                        <option value="deepseek">DeepSeek</option>
                        <option value="groq">Groq</option>
                        <option value="openrouter">OpenRouter</option>
                        <option value="workers-ai">Cloudflare Workers AI</option>
                        <option value="gemini">Google Gemini</option>
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-xs wb-muted">
                      <span>Base URL / 端点地址</span>
                      <input
                        type="text"
                        value={baseUrl}
                        onChange={(e) => setBaseUrl(e.target.value)}
                        className="h-9 px-2.5 rounded-lg border wb-border wb-panel font-mono wb-ink"
                      />
                    </label>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {providerType === 'gemini' ? (
                      <div className="flex flex-col justify-center gap-1 rounded-lg border wb-border wb-panel px-3 py-2 text-xs wb-muted">
                        <span className="font-medium wb-ink">Google Gemini 密钥由后端环境安全托管</span>
                        <span>使用服务端 GEMINI_API_KEY 环境变量安全调用，无需在前端填写密钥。</span>
                      </div>
                    ) : (
                      <label className="flex flex-col gap-1 text-xs wb-muted">
                        <span>API Key / Bearer Token（安全保存在本机浏览器）</span>
                        <input
                          type="password"
                          value={apiKey}
                          onChange={(e) => setApiKey(e.target.value)}
                          placeholder="sk-... / gsk_... / CF API Token"
                          className="h-9 px-2.5 rounded-lg border wb-border wb-panel font-mono wb-ink"
                        />
                      </label>
                    )}

                    {providerType === 'workers-ai' ? (
                      <label className="flex flex-col gap-1 text-xs wb-muted">
                        <span>Cloudflare Account ID</span>
                        <input
                          type="text"
                          value={accountId}
                          onChange={(e) => setAccountId(e.target.value)}
                          placeholder="32位 Cloudflare 账户 ID"
                          className="h-9 px-2.5 rounded-lg border wb-border wb-panel font-mono wb-ink"
                        />
                      </label>
                    ) : (
                      <label className="flex flex-col gap-1 text-xs wb-muted">
                        <span>额度与限制备注</span>
                        <input
                          type="text"
                          value={quotaNote}
                          onChange={(e) => setQuotaNote(e.target.value)}
                          className="h-9 px-2.5 rounded-lg border wb-border wb-panel wb-ink"
                        />
                      </label>
                    )}
                  </div>

                  <label className="flex flex-col gap-1 text-xs wb-muted">
                    <span>自定义模型列表（每行一个模型 ID，保存后自动加入大模型选区）</span>
                    <textarea
                      rows={3}
                      value={modelsText}
                      onChange={(e) => setModelsText(e.target.value)}
                      className="p-2.5 rounded-lg border wb-border wb-panel font-mono text-xs wb-ink"
                    />
                  </label>

                  <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                    <div className="flex flex-wrap items-center gap-4 text-xs wb-ink">
                      <label className="inline-flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={directStream}
                          disabled={providerType === 'gemini' || providerType === 'workers-ai'}
                          onChange={(e) => setDirectStream(e.target.checked)}
                          className="accent-blue-600"
                        />
                        <span>直接由客户端发起安全流式交互 (CORS SSE)</span>
                      </label>
                      <label className="inline-flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={isFreeTier}
                          onChange={(e) => setIsFreeTier(e.target.checked)}
                          className="accent-blue-600"
                        />
                        <span>标明为免费模型</span>
                      </label>
                    </div>
                    <button
                      type="submit"
                      className="h-9 px-4 rounded-lg wb-accent text-xs font-medium"
                    >
                      保存并检测连接
                    </button>
                  </div>
                </form>
              )}

              {/* Provider List */}
              <div className="divide-y wb-border border wb-border rounded-xl overflow-hidden">
                {providers.map((p) => {
                  const st = providerStatuses[p.id] || { status: 'unconfigured', message: '未检测' };
                  const envInjected = hasEnvBackend(p);
                  return (
                    <div key={p.id} className="p-4 wb-panel flex flex-col gap-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2.5 min-w-0">
                          <span className="text-sm font-semibold wb-ink">{p.name}</span>
                          <StatusIndicator status={st.status} latencyMs={st.latencyMs} title={st.message} />
                          <span className="text-xs wb-muted">
                            ·{' '}
                            {p.source === 'custom' && p.apiKey
                              ? '前端已存密钥'
                              : envInjected
                              ? '后端环境变量已注入'
                              : '未配置密钥'}
                          </span>
                          {p.isFreeTier && (
                            <span className="text-xs text-emerald-700 dark:text-emerald-400 font-medium">
                              · 免费额度
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => onProbeProvider(p)}
                            className="h-8 px-2.5 rounded-lg border wb-border text-xs wb-ink hover:opacity-80"
                          >
                            检测连接
                          </button>
                          <button
                            type="button"
                            onClick={() => startEdit(p)}
                            className="h-8 px-2.5 rounded-lg border wb-border text-xs wb-ink hover:opacity-80"
                          >
                            配置 / 模型列表
                          </button>
                          {p.id.startsWith('custom-') && (
                            <button
                              type="button"
                              onClick={() => onDeleteProvider(p.id)}
                              className="h-8 w-8 rounded-lg border wb-border flex items-center justify-center wb-muted hover:text-red-600"
                              title="删除外接 API"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="text-xs wb-muted flex flex-wrap gap-x-3 gap-y-1">
                        <span className="font-mono break-all">{p.baseUrl}</span>
                        <span>· {p.quotaNote}</span>
                        <span>· 状态详情：{st.message}</span>
                      </div>
                      <div className="text-[11px] font-mono wb-muted truncate">
                        模型 ({p.models.length}): {p.models.join(', ')}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Global Generation Params & Reset */}
              <div className="rounded-xl border wb-border p-4 flex flex-wrap items-center justify-between gap-4">
                <label className="flex items-center gap-3 text-xs wb-ink">
                  <span>随机性 Temperature：</span>
                  <input
                    type="range"
                    min={0}
                    max={1.5}
                    step={0.1}
                    value={temperature}
                    onChange={(e) => onChangeTemperature(Number(e.target.value))}
                    className="accent-blue-600"
                  />
                  <span className="font-mono tabular-nums font-medium">{temperature.toFixed(1)}</span>
                </label>

                <button
                  type="button"
                  onClick={onClearAllConversations}
                  className="h-9 px-3.5 rounded-lg border border-red-300 dark:border-red-900/60 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
                >
                  清空所有历史对话
                </button>
              </div>
            </>
          ) : (
            /* Guides Tab */
            <div className="space-y-4">
              {PROVIDER_GUIDES.map((g) => (
                <div
                  key={g.providerType}
                  className="rounded-xl border wb-border p-4 space-y-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold wb-ink">{g.title}</h3>
                      <p className="text-xs text-emerald-700 dark:text-emerald-400 mt-0.5">
                        {g.badge} · {g.corsDirectSupport ? '支持客户端直连 SSE 流式' : '通过后端/边缘节点安全流式调用'}
                      </p>
                    </div>
                    <a
                      href={g.applyUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="h-8 px-3 rounded-lg border wb-border text-xs font-medium wb-accent-text hover:opacity-80 inline-flex items-center gap-1"
                    >
                      <span>前往获取凭证</span>
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs wb-bg p-3 rounded-lg border wb-border">
                    <div>
                      <span className="wb-muted">免费额度：</span>
                      <span className="wb-ink">{g.quotaDetail}</span>
                    </div>
                    <div>
                      <span className="wb-muted">速率与上下文限制：</span>
                      <span className="wb-ink">{g.rateLimits}</span>
                    </div>
                    <div className="md:col-span-2 font-mono text-[11px] wb-muted break-all">
                      接口端点：{g.endpoint}
                    </div>
                  </div>

                  <div className="space-y-1 text-xs wb-ink">
                    <div className="font-medium">详细接入流程：</div>
                    <ol className="list-decimal pl-5 space-y-1 wb-muted">
                      {g.steps.map((s, idx) => (
                        <li key={idx}>{s}</li>
                      ))}
                    </ol>
                  </div>

                  <p className="text-xs wb-muted">使用建议：{g.usageTips}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

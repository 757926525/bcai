import React, { useEffect, useState } from 'react';
import { BookOpen, ExternalLink, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { PROVIDER_GUIDES } from '../data/models';
import { ExternalProvider, ProviderStatusInfo, ProviderType, PublicConfig } from '../types';
import { uid } from '../utils/format';
import { StatusIndicator } from './StatusIndicator';

interface SettingsModalProps {
  open: boolean;
  initialTab?: 'providers' | 'guides';
  onClose: () => void;
  providers: ExternalProvider[];
  providerStatuses: Record<string, ProviderStatusInfo>;
  publicConfig: PublicConfig | null;
  temperature: number;
  onChangeTemperature: (t: number) => void;
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
  initialTab = 'providers',
  onClose,
  providers,
  providerStatuses,
  publicConfig,
  temperature,
  onChangeTemperature,
  onSaveProvider,
  onDeleteProvider,
  onProbeProvider,
  onProbeAll,
  onClearAllConversations,
}) => {
  const [tab, setTab] = useState<'providers' | 'guides'>(initialTab);
  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
      <div className="w-full max-w-4xl max-h-[90vh] flex flex-col rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-4">
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              设置与模型接入中心
            </h2>
            <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800">
              <button
                type="button"
                onClick={() => setTab('providers')}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                  tab === 'providers'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                外接 API 与模型管理
              </button>
              <button
                type="button"
                onClick={() => setTab('guides')}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors inline-flex items-center gap-1 ${
                  tab === 'guides'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                <BookOpen className="w-3.5 h-3.5" />
                <span>免费额度与详细接入指南</span>
              </button>
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
          {tab === 'providers' ? (
            <>
              {/* Header controls */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  支持后端环境变量注入（<code className="font-mono">.env</code> / Cloudflare Secrets）与前端本地保存两种方式，保存后立即同步到大模型选区并可实时探测连接状态。
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={onProbeAll}
                    className="h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>全部检测状态</span>
                  </button>
                  <button
                    type="button"
                    onClick={startNew}
                    className="h-9 px-3.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium inline-flex items-center gap-1.5"
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
                  className="rounded-xl border border-blue-200 dark:border-blue-900 bg-blue-50/40 dark:bg-blue-950/20 p-4 space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {editingId === '__new__' ? '添加外接 API 端点' : `编辑配置：${name}`}
                    </span>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="text-xs text-slate-500 hover:text-slate-800"
                    >
                      取消
                    </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <label className="flex flex-col gap-1 text-xs text-slate-600 dark:text-slate-400">
                      <span>显示名称</span>
                      <input
                        type="text"
                        required
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="h-9 px-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-slate-600 dark:text-slate-400">
                      <span>协议类型</span>
                      <select
                        value={providerType}
                        onChange={(e) => {
                          const t = e.target.value as ProviderType;
                          setProviderType(t);
                          setBaseUrl(DEFAULT_BASE_BY_TYPE[t]);
                          setDirectStream(t !== 'gemini' && t !== 'workers-ai');
                        }}
                        className="h-9 px-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                      >
                        <option value="openai-compatible">OpenAI 兼容端点</option>
                        <option value="deepseek">DeepSeek</option>
                        <option value="groq">Groq</option>
                        <option value="openrouter">OpenRouter</option>
                        <option value="workers-ai">Cloudflare Workers AI</option>
                        <option value="gemini">Google Gemini</option>
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-slate-600 dark:text-slate-400">
                      <span>Base URL / 端点地址</span>
                      <input
                        type="text"
                        value={baseUrl}
                        onChange={(e) => setBaseUrl(e.target.value)}
                        className="h-9 px-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 font-mono text-slate-900 dark:text-slate-100"
                      />
                    </label>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <label className="flex flex-col gap-1 text-xs text-slate-600 dark:text-slate-400">
                      <span>API Key / Bearer Token（前端加密保存在本机浏览器）</span>
                      <input
                        type="password"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder={
                          providerType === 'gemini'
                            ? '可选（若后端已配置 GEMINI_API_KEY 可留空）'
                            : 'sk-... / gsk_... / CF API Token'
                        }
                        className="h-9 px-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 font-mono text-slate-900 dark:text-slate-100"
                      />
                    </label>

                    {providerType === 'workers-ai' ? (
                      <label className="flex flex-col gap-1 text-xs text-slate-600 dark:text-slate-400">
                        <span>Cloudflare Account ID</span>
                        <input
                          type="text"
                          value={accountId}
                          onChange={(e) => setAccountId(e.target.value)}
                          placeholder="32位 Cloudflare 账户 ID"
                          className="h-9 px-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 font-mono text-slate-900 dark:text-slate-100"
                        />
                      </label>
                    ) : (
                      <label className="flex flex-col gap-1 text-xs text-slate-600 dark:text-slate-400">
                        <span>额度与限制备注</span>
                        <input
                          type="text"
                          value={quotaNote}
                          onChange={(e) => setQuotaNote(e.target.value)}
                          className="h-9 px-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                        />
                      </label>
                    )}
                  </div>

                  <label className="flex flex-col gap-1 text-xs text-slate-600 dark:text-slate-400">
                    <span>自定义模型列表（每行一个模型 ID，保存后自动加入大模型选区）</span>
                    <textarea
                      rows={3}
                      value={modelsText}
                      onChange={(e) => setModelsText(e.target.value)}
                      className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 font-mono text-xs text-slate-900 dark:text-slate-100"
                    />
                  </label>

                  <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                    <div className="flex flex-wrap items-center gap-4 text-xs text-slate-700 dark:text-slate-300">
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
                      className="h-9 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium"
                    >
                      保存并检测连接
                    </button>
                  </div>
                </form>
              )}

              {/* Provider List */}
              <div className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                {providers.map((p) => {
                  const st = providerStatuses[p.id] || { status: 'unconfigured', message: '未检测' };
                  const envInjected = hasEnvBackend(p);
                  return (
                    <div key={p.id} className="p-4 bg-white dark:bg-slate-900 flex flex-col gap-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2.5 min-w-0">
                          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                            {p.name}
                          </span>
                          <StatusIndicator status={st.status} latencyMs={st.latencyMs} title={st.message} />
                          <span className="text-xs text-slate-400" aria-hidden="true">
                            ·
                          </span>
                          <span className="text-xs text-slate-500 dark:text-slate-400">
                            {p.source === 'custom' && p.apiKey
                              ? '前端已存密钥'
                              : envInjected
                              ? '后端环境变量已注入'
                              : '未配置密钥'}
                          </span>
                          {p.isFreeTier && (
                            <>
                              <span className="text-xs text-slate-400" aria-hidden="true">
                                ·
                              </span>
                              <span className="text-xs text-emerald-700 dark:text-emerald-400 font-medium">
                                免费额度
                              </span>
                            </>
                          )}
                        </div>

                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => onProbeProvider(p)}
                            className="h-8 px-2.5 rounded-lg border border-slate-200 dark:border-slate-800 text-xs hover:bg-slate-50 dark:hover:bg-slate-800"
                          >
                            检测连接
                          </button>
                          <button
                            type="button"
                            onClick={() => startEdit(p)}
                            className="h-8 px-2.5 rounded-lg border border-slate-200 dark:border-slate-800 text-xs hover:bg-slate-50 dark:hover:bg-slate-800"
                          >
                            配置 / 模型列表
                          </button>
                          {p.id.startsWith('custom-') && (
                            <button
                              type="button"
                              onClick={() => onDeleteProvider(p.id)}
                              className="h-8 w-8 rounded-lg border border-slate-200 dark:border-slate-800 flex items-center justify-center text-slate-500 hover:text-red-600"
                              title="删除外接 API"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="text-xs text-slate-500 dark:text-slate-400 flex flex-wrap gap-x-3 gap-y-1">
                        <span className="font-mono">{p.baseUrl}</span>
                        <span>· {p.quotaNote}</span>
                        <span>· 状态详情：{st.message}</span>
                      </div>
                      <div className="text-[11px] font-mono text-slate-400 dark:text-slate-500 truncate">
                        模型 ({p.models.length}): {p.models.join(', ')}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Global Generation Params & Reset */}
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-4 flex flex-wrap items-center justify-between gap-4">
                <label className="flex items-center gap-3 text-xs text-slate-700 dark:text-slate-300">
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
                  className="h-9 px-3.5 rounded-lg border border-red-200 dark:border-red-900/60 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
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
                  className="rounded-xl border border-slate-200 dark:border-slate-800 p-4 space-y-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                        {g.title}
                      </h3>
                      <p className="text-xs text-emerald-700 dark:text-emerald-400 mt-0.5">
                        {g.badge} · {g.corsDirectSupport ? '支持客户端直连 SSE 流式' : '通过后端/边缘节点安全流式调用'}
                      </p>
                    </div>
                    <a
                      href={g.applyUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="h-8 px-3 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1"
                    >
                      <span>前往获取凭证</span>
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs bg-slate-50 dark:bg-slate-950 p-3 rounded-lg border border-slate-100 dark:border-slate-800">
                    <div>
                      <span className="text-slate-500">免费额度：</span>
                      <span className="text-slate-800 dark:text-slate-200">{g.quotaDetail}</span>
                    </div>
                    <div>
                      <span className="text-slate-500">速率与上下文限制：</span>
                      <span className="text-slate-800 dark:text-slate-200">{g.rateLimits}</span>
                    </div>
                    <div className="md:col-span-2 font-mono text-[11px] text-slate-500">
                      接口端点：{g.endpoint}
                    </div>
                  </div>

                  <div className="space-y-1 text-xs text-slate-700 dark:text-slate-300">
                    <div className="font-medium text-slate-900 dark:text-slate-100">详细接入流程：</div>
                    <ol className="list-decimal pl-5 space-y-1">
                      {g.steps.map((s, idx) => (
                        <li key={idx}>{s}</li>
                      ))}
                    </ol>
                  </div>

                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    使用建议：{g.usageTips}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

import React, { useMemo, useState } from 'react';
import { ChevronDown, RefreshCw, Search, Settings2 } from 'lucide-react';
import { ExternalProvider, ModelOption, ProviderStatusInfo } from '../types';
import { StatusIndicator } from './StatusIndicator';

interface ModelSelectorPopoverProps {
  models: ModelOption[];
  providers: ExternalProvider[];
  providerStatuses: Record<string, ProviderStatusInfo>;
  selectedModelId: string;
  selectedProviderId: string;
  onSelect: (modelId: string, providerId: string) => void;
  onProbeAll: () => void;
  onOpenSettings: () => void;
  probingAll: boolean;
}

export const ModelSelectorPopover: React.FC<ModelSelectorPopoverProps> = ({
  models,
  providers,
  providerStatuses,
  selectedModelId,
  selectedProviderId,
  onSelect,
  onProbeAll,
  onOpenSettings,
  probingAll,
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const activeModel = useMemo(
    () => models.find((m) => m.id === selectedModelId && m.providerId === selectedProviderId) || models.find((m) => m.id === selectedModelId) || models[0],
    [models, selectedModelId, selectedProviderId]
  );

  const activeStatus: ProviderStatusInfo = providerStatuses[activeModel?.providerId || ''] || {
    status: 'unconfigured',
    message: '未检测',
  };

  const filteredModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        m.quotaSummary.toLowerCase().includes(q)
    );
  }, [models, query]);

  const originalModels = filteredModels.filter((m) => m.zone === 'original');
  const freeExtendedModels = filteredModels.filter((m) => m.zone === 'free-extended');

  const getProviderName = (pid: string) => providers.find((p) => p.id === pid)?.name || pid;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2.5 h-10 px-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-700 transition-colors max-w-[340px]"
        aria-expanded={open}
      >
        <StatusIndicator status={activeStatus.status} compact title={activeStatus.message} />
        <span className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
          {activeModel?.name || selectedModelId}
        </span>
        <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 w-[min(94vw,540px)] max-h-[78vh] flex flex-col rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-lg z-50 overflow-hidden">
            {/* Search & Action Header */}
            <div className="p-3 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索模型名称、ID 或免费提供方..."
                  className="w-full h-9 pl-8 pr-3 text-sm rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:border-blue-600"
                />
              </div>
              <button
                type="button"
                onClick={onProbeAll}
                disabled={probingAll}
                className="h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${probingAll ? 'animate-spin' : ''}`} />
                <span>{probingAll ? '检测中' : '全部检测'}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onOpenSettings();
                }}
                className="h-9 px-3 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <Settings2 className="w-3.5 h-3.5" />
                <span>管理外接 API</span>
              </button>
            </div>

            {/* Dual Zones Body */}
            <div className="flex-1 overflow-y-auto divide-y divide-slate-200 dark:divide-slate-800">
              {/* 选区一：原版内置工作台选区 */}
              <div className="p-3">
                <div className="flex items-center justify-between px-2 pb-2">
                  <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    选区一 · 内置工作台模型（保留原样 · CF Workers AI 优先）
                  </span>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {originalModels.length} 项
                  </span>
                </div>
                <div className="space-y-1">
                  {originalModels.map((m) => {
                    const st = providerStatuses[m.providerId] || { status: 'unconfigured', message: '未检测' };
                    const isSelected = m.id === selectedModelId && m.providerId === selectedProviderId;
                    return (
                      <button
                        key={`${m.providerId}-${m.id}`}
                        type="button"
                        onClick={() => {
                          onSelect(m.id, m.providerId);
                          setOpen(false);
                        }}
                        className={`w-full text-left px-3 py-2 rounded-lg flex items-center justify-between gap-3 transition-colors ${
                          isSelected
                            ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-900 dark:text-blue-100'
                            : 'hover:bg-slate-50 dark:hover:bg-slate-800/70'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium truncate">{m.name}</span>
                          </div>
                          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 truncate mt-0.5">
                            <span className="font-mono truncate">{m.id}</span>
                            <span aria-hidden="true">·</span>
                            <span>{m.quotaSummary}</span>
                          </div>
                        </div>
                        <StatusIndicator status={st.status} latencyMs={st.latencyMs} title={st.message} />
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 选区二：免费扩展与外接自定义模型选区 */}
              <div className="p-3">
                <div className="flex items-center justify-between px-2 pb-2">
                  <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    选区二 · 免费扩展与外接 API 模型（DeepSeek · Groq · Gemini · OpenAI 兼容）
                  </span>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {freeExtendedModels.length} 项
                  </span>
                </div>
                <div className="space-y-1">
                  {freeExtendedModels.map((m) => {
                    const st = providerStatuses[m.providerId] || { status: 'unconfigured', message: '未检测' };
                    const isSelected = m.id === selectedModelId && m.providerId === selectedProviderId;
                    return (
                      <button
                        key={`${m.providerId}-${m.id}`}
                        type="button"
                        onClick={() => {
                          onSelect(m.id, m.providerId);
                          setOpen(false);
                        }}
                        className={`w-full text-left px-3 py-2 rounded-lg flex items-center justify-between gap-3 transition-colors ${
                          isSelected
                            ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-900 dark:text-blue-100'
                            : 'hover:bg-slate-50 dark:hover:bg-slate-800/70'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium truncate">{m.name}</span>
                            {m.isFree && (
                              <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400 shrink-0">
                                免费
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 truncate mt-0.5">
                            <span>{getProviderName(m.providerId)}</span>
                            <span aria-hidden="true">·</span>
                            <span>{m.quotaSummary}</span>
                            <span aria-hidden="true">·</span>
                            <span>{m.streamMode === 'direct' ? '客户端直连流式' : '后端安全代理'}</span>
                          </div>
                        </div>
                        <StatusIndicator status={st.status} latencyMs={st.latencyMs} title={st.message} />
                      </button>
                    );
                  })}
                  {freeExtendedModels.length === 0 && (
                    <p className="text-xs text-slate-500 px-2 py-4 text-center">没有匹配的模型，请在右上角“管理外接 API”中新增自定义模型。</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

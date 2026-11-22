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
  isAdmin: boolean;
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
  isAdmin,
  onSelect,
  onProbeAll,
  onOpenSettings,
  probingAll,
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const activeModel = useMemo(
    () =>
      models.find((m) => m.id === selectedModelId && m.providerId === selectedProviderId) ||
      models.find((m) => m.id === selectedModelId) ||
      models[0],
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
    <div className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 sm:gap-2 h-9 sm:h-10 px-2 sm:px-3 rounded-lg border wb-border wb-panel hover:opacity-90 transition-colors max-w-[118px] sm:max-w-[260px]"
        aria-expanded={open}
      >
        <StatusIndicator status={activeStatus.status} compact title={activeStatus.message} />
        <span className="text-xs sm:text-sm font-medium wb-ink truncate">
          {activeModel?.name || selectedModelId}
        </span>
        <ChevronDown className="w-3.5 h-3.5 wb-muted shrink-0" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="fixed inset-x-3 top-14 sm:inset-x-auto sm:absolute sm:right-0 sm:top-full sm:mt-2 sm:w-[540px] max-h-[78vh] flex flex-col rounded-xl border wb-border wb-panel shadow-xl z-50 overflow-hidden">
            {/* Search & Action Header */}
            <div className="p-3 border-b wb-border flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[160px]">
                <Search className="w-4 h-4 wb-muted absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索模型名称、ID 或免费提供方…"
                  className="w-full h-9 pl-8 pr-3 text-xs sm:text-sm rounded-lg border wb-border wb-bg wb-ink focus:outline-none"
                />
              </div>
              <button
                type="button"
                onClick={onProbeAll}
                disabled={probingAll}
                className="h-9 px-3 rounded-lg border wb-border text-xs font-medium wb-ink hover:opacity-80 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${probingAll ? 'animate-spin' : ''}`} />
                <span>{probingAll ? '检测中' : '全部检测'}</span>
              </button>
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onOpenSettings();
                  }}
                  className="h-9 px-3 rounded-lg wb-accent text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <Settings2 className="w-3.5 h-3.5" />
                  <span>管理外接 API</span>
                </button>
              )}
            </div>

            {/* Dual Zones Body */}
            <div className="flex-1 overflow-y-auto divide-y wb-border">
              {/* 选区一：内置工作台选区 */}
              <div className="p-3">
                <div className="flex items-center justify-between px-2 pb-2 gap-2">
                  <span className="text-xs font-semibold wb-ink truncate">
                    选区一 · 内置工作台模型（CF Workers AI 免费优先）
                  </span>
                  <span className="text-xs wb-muted shrink-0">{originalModels.length} 项</span>
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
                          isSelected ? 'wb-tint wb-ink' : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.03]'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-xs sm:text-sm font-medium wb-ink truncate">{m.name}</span>
                            {m.supportsVision && (
                              <span className="text-[11px] wb-accent-text shrink-0">看图</span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 text-[11px] wb-muted truncate mt-0.5">
                            <span className="font-mono truncate">{m.id}</span>
                            <span aria-hidden="true">·</span>
                            <span className="shrink-0">{m.quotaSummary}</span>
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
                <div className="flex items-center justify-between px-2 pb-2 gap-2">
                  <span className="text-xs font-semibold wb-ink truncate">
                    选区二 · 免费扩展与外接 API（Gemini · DeepSeek · Groq · OpenRouter）
                  </span>
                  <span className="text-xs wb-muted shrink-0">{freeExtendedModels.length} 项</span>
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
                          isSelected ? 'wb-tint wb-ink' : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.03]'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-xs sm:text-sm font-medium wb-ink truncate">{m.name}</span>
                            {m.isFree && (
                              <span className="text-[11px] font-medium text-emerald-700 dark:text-emerald-400 shrink-0">
                                免费
                              </span>
                            )}
                            {m.supportsVision && (
                              <span className="text-[11px] wb-accent-text shrink-0">多模态</span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 text-[11px] wb-muted truncate mt-0.5">
                            <span className="truncate">{getProviderName(m.providerId)}</span>
                            <span aria-hidden="true">·</span>
                            <span className="truncate">{m.quotaSummary}</span>
                          </div>
                        </div>
                        <StatusIndicator status={st.status} latencyMs={st.latencyMs} title={st.message} />
                      </button>
                    );
                  })}
                  {freeExtendedModels.length === 0 && (
                    <p className="text-xs wb-muted px-2 py-4 text-center">
                      没有匹配的模型{isAdmin ? '，可点击右上角“管理外接 API”新增' : ''}。
                    </p>
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

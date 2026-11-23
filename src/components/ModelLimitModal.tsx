import React, { useState } from 'react';
import {
  AlertTriangle,
  ArrowRightLeft,
  ChevronDown,
  ChevronUp,
  Play,
  RefreshCw,
  Settings,
  ShieldAlert,
  X,
} from 'lucide-react';
import { ModelLimitAlert } from '../utils/limitAlerts';

interface ModelLimitModalProps {
  alert: ModelLimitAlert | null;
  onClose: () => void;
  onContinuePartial?: () => void;
  onRetryCurrent?: () => void;
  onSwitchToRecommended?: (modelId: string, providerId?: string) => void;
  onOpenSettings?: () => void;
}

const CATEGORY_BADGES: Record<ModelLimitAlert['category'], { label: string; cls: string }> = {
  rate_limit: { label: '速率 / 配额限流 (429)', cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30' },
  quota_exhausted: { label: '额度不足 / 付费限制', cls: 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30' },
  max_tokens: { label: '输出长度达上限', cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30' },
  context_length: { label: '上下文窗口超限', cls: 'bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30' },
  safety_filter: { label: '安全 / 策略截断', cls: 'bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30' },
  overloaded: { label: '上游高负载 / 超时', cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30' },
  missing_credentials: { label: '缺少 Key / 鉴权受限', cls: 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30' },
  stream_interrupted: { label: '流式传输中断', cls: 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30' },
  unknown: { label: '模型调用受限', cls: 'bg-slate-500/15 text-slate-700 dark:text-slate-300 border-slate-500/30' },
};

export const ModelLimitModal: React.FC<ModelLimitModalProps> = ({
  alert,
  onClose,
  onContinuePartial,
  onRetryCurrent,
  onSwitchToRecommended,
  onOpenSettings,
}) => {
  const [showRaw, setShowRaw] = useState(false);

  if (!alert) return null;

  const badge = CATEGORY_BADGES[alert.category] || CATEGORY_BADGES.unknown;
  const isDanger = alert.category === 'quota_exhausted' || alert.category === 'safety_filter' || alert.category === 'stream_interrupted';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-[2px] p-3 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="model-limit-modal-title"
    >
      <div className="w-full max-w-lg rounded-2xl border wb-border wb-panel shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Top Banner */}
        <div className="px-5 py-4 border-b wb-border flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <div
              className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                isDanger ? 'bg-red-500/15 text-red-600 dark:text-red-400' : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
              }`}
            >
              {isDanger ? <ShieldAlert className="w-5 h-5" /> : <AlertTriangle className="w-5 h-5" />}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`px-2 py-0.5 rounded-md border text-[11px] font-medium ${badge.cls}`}>
                  {badge.label}
                </span>
                {alert.statusCode && (
                  <span className="text-[11px] font-mono wb-muted">HTTP {alert.statusCode}</span>
                )}
              </div>
              <h3 id="model-limit-modal-title" className="text-sm sm:text-base font-semibold wb-ink mt-1.5">
                {alert.title}
              </h3>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center wb-muted hover:bg-black/5 dark:hover:bg-white/5 shrink-0"
            aria-label="关闭限制提醒弹窗"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-3.5 text-xs sm:text-sm">
          <div className="rounded-xl border wb-border wb-bg p-3.5 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] wb-muted">
              <span>
                受限模型：<code className="font-mono wb-ink font-semibold">{alert.modelId}</code>
              </span>
              {alert.finishReason && (
                <span>
                  停止原因：<code className="font-mono wb-ink">{alert.finishReason}</code>
                </span>
              )}
            </div>
            <p className="wb-ink leading-relaxed text-xs sm:text-sm">{alert.summary}</p>
            <p className="text-xs wb-muted leading-relaxed">💡 建议：{alert.suggestion}</p>
          </div>

          {alert.detail && alert.detail !== alert.summary && (
            <div>
              <button
                type="button"
                onClick={() => setShowRaw((v) => !v)}
                className="text-[11px] wb-muted hover:wb-ink inline-flex items-center gap-1"
              >
                {showRaw ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                <span>{showRaw ? '收起原始响应详情' : '查看接口返回详情'}</span>
              </button>
              {showRaw && (
                <pre className="mt-1.5 p-2.5 rounded-lg border wb-border wb-code text-[11px] font-mono wb-muted overflow-x-auto max-h-28 whitespace-pre-wrap break-all">
                  {alert.detail}
                </pre>
              )}
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
            {alert.recommendedModelId && onSwitchToRecommended && (
              <button
                type="button"
                onClick={() => {
                  onSwitchToRecommended(alert.recommendedModelId!, alert.recommendedProviderId);
                  onClose();
                }}
                className="h-9 px-3.5 rounded-lg wb-accent text-xs font-medium inline-flex items-center gap-1.5"
              >
                <ArrowRightLeft className="w-3.5 h-3.5" />
                <span>
                  切换至「{alert.recommendedModelLabel || alert.recommendedModelId}」
                  {alert.canContinuePartial ? '继续' : '重试'}
                </span>
              </button>
            )}

            {alert.canContinuePartial && onContinuePartial && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onContinuePartial();
                }}
                className="h-9 px-3.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium inline-flex items-center gap-1.5"
              >
                <Play className="w-3.5 h-3.5" />
                <span>继续断点续写</span>
              </button>
            )}

            {!alert.canContinuePartial && alert.canRetryCurrent && onRetryCurrent && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onRetryCurrent();
                }}
                className="h-9 px-3.5 rounded-lg border border-blue-500/40 wb-tint wb-accent-text text-xs font-medium inline-flex items-center gap-1.5"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>立即重试</span>
              </button>
            )}

            {onOpenSettings && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenSettings();
                }}
                className="h-9 px-3 rounded-lg border wb-border wb-bg text-xs font-medium wb-ink hover:opacity-80 inline-flex items-center gap-1.5"
              >
                <Settings className="w-3.5 h-3.5" />
                <span>模型 / API 设置</span>
              </button>
            )}

            <button
              type="button"
              onClick={onClose}
              className="h-9 px-3 rounded-lg border wb-border text-xs wb-muted hover:wb-ink"
            >
              知道了
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

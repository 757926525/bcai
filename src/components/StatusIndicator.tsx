import React, { useEffect, useState } from 'react';
import { FileArchive, Sparkles } from 'lucide-react';
import { ConnectionState, ProviderStatusInfo } from '../types';

interface StatusIndicatorProps {
  status: ConnectionState;
  latencyMs?: number;
  compact?: boolean;
  title?: string;
}

export const StatusIndicator: React.FC<StatusIndicatorProps> = ({
  status,
  latencyMs,
  compact = false,
  title,
}) => {
  const config: Record<ConnectionState, { dot: string; label: string; text: string }> = {
    unconfigured: {
      dot: 'bg-slate-400 dark:bg-slate-600',
      label: '未连接',
      text: 'text-slate-500 dark:text-slate-400',
    },
    checking: {
      dot: 'bg-amber-500 animate-pulse',
      label: '检测中',
      text: 'text-amber-700 dark:text-amber-400',
    },
    connected: {
      dot: 'bg-emerald-600 dark:bg-emerald-500',
      label: latencyMs ? `已连接 ${latencyMs}ms` : '已连接',
      text: 'text-emerald-700 dark:text-emerald-400',
    },
    error: {
      dot: 'bg-red-600 dark:bg-red-500',
      label: '异常',
      text: 'text-red-700 dark:text-red-400',
    },
  };

  const c = config[status];

  return (
    <span
      title={title || c.label}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 text-xs tabular-nums ${c.text}`}
    >
      <span className={`w-2 h-2 rounded-full shrink-0 ${c.dot}`} aria-hidden="true" />
      {!compact && <span>{c.label}</span>}
    </span>
  );
};

export type ProjectWritePhase =
  | 'idle'
  | 'connecting'
  | 'thinking'
  | 'writing'
  | 'continuing'
  | 'fallback'
  | 'paused'
  | 'truncated'
  | 'error'
  | 'done';

export interface ProjectStatusLightsProps {
  mode: 'chat' | 'code' | 'repo';
  phase: ProjectWritePhase;
  isStreaming: boolean;
  modelId: string;
  activeStreamModel?: string;
  providerStatus?: ProviderStatusInfo;
  streamStartedAt?: number | null;
  codeBlockCount: number;
  codeFileNames: string[];
  totalCodeLines: number;
  generatedChars: number;
  hasUnclosedCode: boolean;
  autoContinue: boolean;
  onToggleAutoContinue: () => void;
  onExportProjectZip?: () => void;
  canExportZip: boolean;
}

export const ProjectStatusLights: React.FC<ProjectStatusLightsProps> = ({
  mode,
  phase,
  isStreaming,
  modelId,
  activeStreamModel,
  providerStatus,
  streamStartedAt,
  codeBlockCount,
  codeFileNames,
  totalCodeLines,
  generatedChars,
  hasUnclosedCode,
  autoContinue,
  onToggleAutoContinue,
  onExportProjectZip,
  canExportZip,
}) => {
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    if (!isStreaming || !streamStartedAt) {
      if (!isStreaming) setElapsedSec(0);
      return;
    }
    setElapsedSec((Date.now() - streamStartedAt) / 1000);
    const id = setInterval(() => {
      setElapsedSec((Date.now() - streamStartedAt) / 1000);
    }, 200);
    return () => clearInterval(id);
  }, [isStreaming, streamStartedAt]);

  const effectiveModel = activeStreamModel || modelId;
  const linkStatus: ConnectionState = providerStatus?.status || 'unconfigured';

  const stageMeta: Record<
    ProjectWritePhase,
    { dot: string; label: string; text: string }
  > = {
    idle: {
      dot: 'bg-emerald-500/80',
      label: mode === 'code' ? '编程就绪' : mode === 'repo' ? '仓库就绪' : '对话就绪',
      text: 'wb-muted',
    },
    connecting: {
      dot: 'bg-amber-500 animate-ping',
      label: '① 正在连接模型…',
      text: 'text-amber-700 dark:text-amber-300',
    },
    thinking: {
      dot: 'bg-blue-500 animate-pulse',
      label: '② 架构思考规划中…',
      text: 'text-blue-700 dark:text-blue-300',
    },
    fallback: {
      dot: 'bg-amber-500 animate-pulse',
      label: `② 高负载自动切至 ${effectiveModel}`,
      text: 'text-amber-700 dark:text-amber-300',
    },
    writing: {
      dot: 'bg-emerald-500 animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.75)]',
      label: mode === 'code' || mode === 'repo' ? '③ 实时编写项目代码…' : '③ 实时流式输出中…',
      text: 'text-emerald-700 dark:text-emerald-300 font-medium',
    },
    continuing: {
      dot: 'bg-cyan-500 animate-pulse shadow-[0_0_8px_rgba(6,182,212,0.75)]',
      label: '④ 防中断自动续写中…',
      text: 'text-cyan-700 dark:text-cyan-300 font-medium',
    },
    paused: {
      dot: 'bg-amber-500',
      label: '已暂停/中断 · 可续写',
      text: 'text-amber-700 dark:text-amber-300 font-medium',
    },
    truncated: {
      dot: 'bg-amber-500 animate-pulse',
      label: '长输出分段截断 · 待续写',
      text: 'text-amber-700 dark:text-amber-300 font-medium',
    },
    error: {
      dot: 'bg-red-600',
      label: '响应异常 · 可切换模型或重试',
      text: 'text-red-700 dark:text-red-400 font-medium',
    },
    done: {
      dot: 'bg-emerald-600',
      label: codeBlockCount > 0 ? '编写完成 · 代码完整' : '生成完成',
      text: 'text-emerald-700 dark:text-emerald-400',
    },
  };

  const st = stageMeta[phase] || stageMeta.idle;

  const integrityDot = isStreaming
    ? hasUnclosedCode
      ? 'bg-amber-500 animate-pulse'
      : 'bg-emerald-500 animate-pulse'
    : hasUnclosedCode
    ? 'bg-red-500'
    : codeBlockCount > 0
    ? 'bg-emerald-600'
    : 'bg-slate-400 dark:bg-slate-600';

  const integrityText = isStreaming
    ? hasUnclosedCode
      ? '代码块流式写入中'
      : codeBlockCount > 0
      ? `${codeBlockCount} 个模块 · ${totalCodeLines} 行`
      : `${generatedChars} 字`
    : hasUnclosedCode
    ? '存在未闭合代码块（建议点续写）'
    : codeBlockCount > 0
    ? `${codeBlockCount} 个模块 (${codeFileNames.slice(0, 2).join(', ')}${codeFileNames.length > 2 ? '…' : ''}) · ${totalCodeLines} 行`
    : '暂无代码模块';

  return (
    <div className="border-b wb-border wb-panel/90 px-2.5 sm:px-4 py-1.5 shrink-0">
      <div className="max-w-3xl mx-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] tabular-nums">
        {/* Left: 3 Live LEDs (Model Link + Writing Stage + Code Integrity) */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
          {/* LED 1: Model Link */}
          <span
            className="inline-flex items-center gap-1.5 min-w-0"
            title={providerStatus?.message || `当前模型: ${effectiveModel}`}
          >
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${
                linkStatus === 'connected'
                  ? 'bg-emerald-600 shadow-[0_0_6px_rgba(5,150,105,0.65)]'
                  : linkStatus === 'checking'
                  ? 'bg-amber-500 animate-pulse'
                  : linkStatus === 'error'
                  ? 'bg-red-600'
                  : 'bg-slate-400'
              }`}
              aria-hidden="true"
            />
            <span className="wb-muted truncate max-w-[140px] sm:max-w-[200px] font-mono">
              {effectiveModel}
            </span>
          </span>

          <span className="wb-muted opacity-40" aria-hidden="true">|</span>

          {/* LED 2: Live Project Writing Phase */}
          <span className={`inline-flex items-center gap-1.5 ${st.text}`}>
            <span className={`w-2 h-2 rounded-full shrink-0 ${st.dot}`} aria-hidden="true" />
            <span>{st.label}</span>
            {isStreaming && elapsedSec > 0 && (
              <span className="font-mono opacity-80">{elapsedSec.toFixed(1)}s</span>
            )}
          </span>

          {/* LED 3: Code Completeness & Metrics */}
          {(mode === 'code' || mode === 'repo' || codeBlockCount > 0 || isStreaming) && (
            <>
              <span className="hidden sm:inline wb-muted opacity-40" aria-hidden="true">|</span>
              <span
                className="hidden sm:inline-flex items-center gap-1.5 wb-muted"
                title={codeFileNames.length > 0 ? `已识别文件: ${codeFileNames.join(', ')}` : integrityText}
              >
                <span className={`w-2 h-2 rounded-full shrink-0 ${integrityDot}`} aria-hidden="true" />
                <span className="truncate max-w-[240px]">{integrityText}</span>
              </span>
            </>
          )}
        </div>

        {/* Right: Auto-continue toggle + 1-click Project ZIP */}
        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={onToggleAutoContinue}
            title="开启后，长文章或大型项目触发字数上限截断时将自动续写"
            className={`inline-flex items-center gap-1 transition-colors ${
              autoContinue ? 'wb-accent-text font-medium' : 'wb-muted hover:wb-ink'
            }`}
          >
            <Sparkles className="w-3 h-3" />
            <span>{autoContinue ? '防中断续写:开' : '防中断续写:关'}</span>
          </button>

          {canExportZip && onExportProjectZip && codeBlockCount > 0 && (
            <button
              type="button"
              onClick={onExportProjectZip}
              className="inline-flex items-center gap-1 wb-accent-text hover:underline font-medium"
              title="按文件路径打包下载当前项目全部代码 (.zip)"
            >
              <FileArchive className="w-3 h-3" />
              <span>导出项目({codeBlockCount})</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

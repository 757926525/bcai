import React from 'react';
import { ConnectionState } from '../types';

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

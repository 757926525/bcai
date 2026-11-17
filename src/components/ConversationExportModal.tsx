import React, { useEffect, useState } from 'react';
import { CheckSquare, Download, FileText, Square, X } from 'lucide-react';
import { Conversation } from '../types';
import { formatDateTime } from '../utils/format';

interface ConversationExportModalProps {
  open: boolean;
  onClose: () => void;
  conversations: Conversation[];
  initialSelectedIds?: string[];
  onExported?: (filename: string, count: number) => void;
}

export const ConversationExportModal: React.FC<ConversationExportModalProps> = ({
  open,
  onClose,
  conversations,
  initialSelectedIds,
  onExported,
}) => {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [fileName, setFileName] = useState('');

  useEffect(() => {
    if (open) {
      const defaults =
        initialSelectedIds && initialSelectedIds.length > 0
          ? initialSelectedIds
          : conversations.map((c) => c.id);
      setSelectedIds(defaults);
      const stamp = new Date().toISOString().slice(0, 10);
      setFileName(`bcai-conversations-${stamp}.txt`);
    }
  }, [open, conversations, initialSelectedIds]);

  if (!open) return null;

  const toggleId = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const selectAll = () => setSelectedIds(conversations.map((c) => c.id));
  const invertSelection = () =>
    setSelectedIds(conversations.filter((c) => !selectedIds.includes(c.id)).map((c) => c.id));
  const clearAll = () => setSelectedIds([]);

  const handleDownloadTxt = () => {
    const picked = conversations.filter((c) => selectedIds.includes(c.id));
    if (picked.length === 0) return;

    const lines: string[] = [];
    lines.push('============================================================');
    lines.push('BCAI 工作台 - 合并对话导出记录');
    lines.push(`导出时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}`);
    lines.push(`包含会话数: ${picked.length}`);
    lines.push('============================================================\n');

    picked.forEach((conv, idx) => {
      const modeName = conv.mode === 'code' ? 'AI 编程' : conv.mode === 'repo' ? '仓库协同' : 'AI 对话';
      lines.push(`[${idx + 1}] 会话标题: ${conv.title}`);
      lines.push(`模式: ${modeName} | 模型: ${conv.modelId} | 状态: ${conv.status === 'paused' ? '已暂停' : '进行中'}`);
      if (conv.repoFullName) {
        lines.push(`关联仓库: ${conv.repoFullName} (${conv.repoBranch || 'main'})`);
      }
      lines.push(`创建时间: ${formatDateTime(conv.createdAt)} | 最近更新: ${formatDateTime(conv.updatedAt)}`);
      lines.push('------------------------------------------------------------');

      if (conv.messages.length === 0) {
        lines.push('（此会话暂无消息记录）');
      } else {
        conv.messages.forEach((msg) => {
          const sender = msg.role === 'user' ? '用户' : `助手 (${msg.modelId || conv.modelId})`;
          lines.push(`\n[${formatDateTime(msg.createdAt)}] ${sender}:`);
          if (msg.attachments && msg.attachments.length > 0) {
            lines.push(
              `[附带文件/图片]: ${msg.attachments
                .map((a) => `${a.name} (${a.kind === 'image' ? '图片' : '文件'})`)
                .join(', ')}`
            );
          }
          lines.push(msg.content || '');
        });
      }
      lines.push('\n============================================================\n');
    });

    const cleanName = (fileName.trim() || `bcai-conversations-${Date.now()}`).replace(/[\\/:*?"<>|]/g, '_');
    const finalName = cleanName.toLowerCase().endsWith('.txt') ? cleanName : `${cleanName}.txt`;

    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = finalName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    onExported?.(finalName, picked.length);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-3 sm:p-4">
      <div className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-xl border wb-border wb-panel shadow-xl overflow-hidden">
        <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b wb-border gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <FileText className="w-5 h-5 wb-accent-text shrink-0" />
            <div className="min-w-0">
              <h2 className="text-base font-semibold wb-ink truncate">合并下载对话记录 (.txt)</h2>
              <p className="text-xs wb-muted truncate">勾选要导出的会话并命名文件，系统将按时间合并为单个 txt</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-10 h-10 rounded-lg flex items-center justify-center wb-muted hover:bg-black/5 dark:hover:bg-white/5 shrink-0"
            aria-label="关闭弹窗"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs wb-muted">
              已选择 <strong className="wb-ink tabular-nums">{selectedIds.length}</strong> / {conversations.length} 个会话
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={selectAll}
                className="h-8 px-2.5 rounded-lg border wb-border text-xs wb-ink hover:opacity-80"
              >
                全选
              </button>
              <button
                type="button"
                onClick={invertSelection}
                className="h-8 px-2.5 rounded-lg border wb-border text-xs wb-ink hover:opacity-80"
              >
                反选
              </button>
              <button
                type="button"
                onClick={clearAll}
                className="h-8 px-2.5 rounded-lg border wb-border text-xs wb-muted hover:wb-ink"
              >
                清空选择
              </button>
            </div>
          </div>

          <div className="border wb-border rounded-xl divide-y wb-border max-h-[42vh] overflow-y-auto">
            {conversations.map((c) => {
              const checked = selectedIds.includes(c.id);
              const modeLabel = c.mode === 'code' ? '编程' : c.mode === 'repo' ? '仓库' : '对话';
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggleId(c.id)}
                  className={`w-full text-left px-3.5 py-2.5 flex items-center gap-3 transition-colors ${
                    checked ? 'wb-tint' : 'hover:bg-black/[0.02] dark:hover:bg-white/[0.02]'
                  }`}
                >
                  {checked ? (
                    <CheckSquare className="w-4 h-4 wb-accent-text shrink-0" />
                  ) : (
                    <Square className="w-4 h-4 wb-muted shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium wb-ink truncate">{c.title}</div>
                    <div className="text-[11px] wb-muted flex flex-wrap items-center gap-1.5 mt-0.5 tabular-nums">
                      <span>{modeLabel}</span>
                      <span aria-hidden="true">·</span>
                      <span>{c.messages.length} 条消息</span>
                      <span aria-hidden="true">·</span>
                      <span>{formatDateTime(c.updatedAt)}</span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium wb-ink block">导出文件名（自动补充 .txt 后缀）</label>
            <input
              type="text"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              placeholder="例如：bcai-项目架构讨论记录.txt"
              className="w-full h-10 px-3 rounded-lg border wb-border wb-bg text-sm wb-ink focus:outline-none"
            />
          </div>
        </div>

        <div className="px-4 sm:px-6 py-3.5 border-t wb-border flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-10 px-4 rounded-lg border wb-border text-xs font-medium wb-ink hover:opacity-80"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleDownloadTxt}
            disabled={selectedIds.length === 0}
            className="h-10 px-5 rounded-lg wb-accent text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-40 whitespace-nowrap"
          >
            <Download className="w-4 h-4" />
            <span>合并下载为 .txt ({selectedIds.length})</span>
          </button>
        </div>
      </div>
    </div>
  );
};

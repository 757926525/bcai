import React, { useEffect, useRef, useState } from 'react';
import {
  FileCode2,
  GitBranch,
  Pause,
  Play,
  Send,
  Square,
  Trash2,
} from 'lucide-react';
import { MODE_SUGGESTIONS } from '../data/models';
import { Conversation, ModelOption, ProviderStatusInfo } from '../types';
import { formatDateTime, formatTimeShort } from '../utils/format';
import { MarkdownRenderer } from './MarkdownRenderer';
import { StatusIndicator } from './StatusIndicator';

interface ChatWorkspaceProps {
  conversation: Conversation;
  activeModel?: ModelOption;
  providerStatus?: ProviderStatusInfo;
  isStreaming: boolean;
  onSend: (text: string) => void;
  onStopStream: () => void;
  onTogglePauseSession: () => void;
  onResumePartial: () => void;
  onClearAttachedFile: () => void;
  onSaveCodeToDb: (code: string, lang: string) => void;
  onSendCodeToRepo: (code: string, lang: string) => void;
  repoConnected: boolean;
  onOpenRepoTab: () => void;
}

export const ChatWorkspace: React.FC<ChatWorkspaceProps> = ({
  conversation,
  activeModel,
  providerStatus,
  isStreaming,
  onSend,
  onStopStream,
  onTogglePauseSession,
  onResumePartial,
  onClearAttachedFile,
  onSaveCodeToDb,
  onSendCodeToRepo,
  repoConnected,
  onOpenRepoTab,
}) => {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom || conversation.messages.length <= 2) {
      el.scrollTop = el.scrollHeight;
    }
  }, [conversation.messages, conversation.id]);

  const adjustHeight = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  const handleSubmit = () => {
    if (isStreaming) {
      onStopStream();
      return;
    }
    const text = input.trim();
    if (!text || conversation.status === 'paused') return;
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    onSend(text);
  };

  const lastMessage = conversation.messages[conversation.messages.length - 1];
  const canContinuePartial =
    !isStreaming &&
    conversation.status === 'active' &&
    lastMessage?.role === 'assistant' &&
    lastMessage?.paused;

  const isRepoMode = conversation.mode === 'repo' || Boolean(conversation.repoFullName);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* 对话框顶部状态栏：显示仓库分支、对话时间记录与暂停会话控制 */}
      <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex flex-wrap items-center gap-3 min-w-0">
          {isRepoMode ? (
            <button
              type="button"
              onClick={onOpenRepoTab}
              className="inline-flex items-center gap-1.5 font-medium text-blue-700 dark:text-blue-400 hover:underline truncate"
              title="点击切换仓库或分支"
            >
              <GitBranch className="w-3.5 h-3.5 shrink-0" />
              <span className="font-mono truncate">
                {conversation.repoFullName || '757926525/aimx'} / {conversation.repoBranch || 'main'}
              </span>
            </button>
          ) : (
            <span className="font-medium text-slate-700 dark:text-slate-300">
              {conversation.mode === 'code' ? 'AI 编程模式' : 'AI 对话模式'}
            </span>
          )}

          {conversation.attachedFilePath && (
            <span className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-300 font-mono truncate max-w-[260px]">
              <FileCode2 className="w-3.5 h-3.5 shrink-0 text-slate-400" />
              <span className="truncate">{conversation.attachedFilePath}</span>
              <button
                type="button"
                onClick={onClearAttachedFile}
                className="text-slate-400 hover:text-red-600 ml-0.5"
                title="移除当前附带的仓库文件"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </span>
          )}

          <span className="text-slate-400 dark:text-slate-500 hidden sm:inline" aria-hidden="true">
            ·
          </span>
          <span className="text-slate-500 dark:text-slate-400 tabular-nums hidden sm:inline">
            会话创建 {formatDateTime(conversation.createdAt)}
          </span>
          <span className="text-slate-400 dark:text-slate-500 hidden md:inline" aria-hidden="true">
            ·
          </span>
          <span className="text-slate-500 dark:text-slate-400 tabular-nums hidden md:inline">
            最近更新 {formatTimeShort(conversation.updatedAt)}
          </span>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          {activeModel && (
            <div className="hidden lg:flex items-center gap-2 text-slate-500 dark:text-slate-400">
              <span>{activeModel.streamMode === 'direct' ? '直连流式' : '代理流式'}</span>
              <StatusIndicator
                status={providerStatus?.status || 'unconfigured'}
                latencyMs={providerStatus?.latencyMs}
              />
            </div>
          )}

          <button
            type="button"
            onClick={onTogglePauseSession}
            className={`h-8 px-2.5 rounded-lg border text-xs font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
              conversation.status === 'paused'
                ? 'border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300'
                : 'border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
            }`}
          >
            {conversation.status === 'paused' ? (
              <>
                <Play className="w-3.5 h-3.5" />
                <span>已暂停 · 点击恢复</span>
              </>
            ) : (
              <>
                <Pause className="w-3.5 h-3.5" />
                <span>暂停会话</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Messages Viewport */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6">
        <div className="max-w-3xl mx-auto space-y-6">
          {conversation.messages.length === 0 ? (
            <div className="py-12 text-center space-y-5">
              <div className="space-y-1.5">
                <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
                  {conversation.mode === 'code'
                    ? '编写、重构与调试完整代码'
                    : conversation.mode === 'repo'
                    ? '基于 GitHub 仓库分支协同编程'
                    : '多模型自由流式对话工作台'}
                </h1>
                <p className="text-sm text-slate-500 dark:text-slate-400 max-w-lg mx-auto">
                  右上角可切换“内置工作台选区”与“免费扩展/外接模型选区”，连接状态灯会实时反映模型真实连通情况。
                </p>
              </div>
              <div className="flex flex-col gap-2 max-w-xl mx-auto">
                {MODE_SUGGESTIONS[conversation.mode].map((s, idx) => (
                  <button
                    key={idx}
                    type="button"
                    disabled={conversation.status === 'paused'}
                    onClick={() => onSend(s)}
                    className="text-left px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-blue-500 dark:hover:border-blue-500 text-sm text-slate-700 dark:text-slate-200 transition-colors disabled:opacity-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            conversation.messages.map((m) => (
              <div
                key={m.id}
                className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}
              >
                <div className="flex items-center gap-2 text-[11px] text-slate-400 dark:text-slate-500 mb-1 px-1 tabular-nums">
                  <span>{m.role === 'user' ? '我' : m.modelId || conversation.modelId}</span>
                  <span aria-hidden="true">·</span>
                  <span>{formatTimeShort(m.createdAt)}</span>
                  {m.paused && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="text-amber-600 dark:text-amber-400 font-medium">已中止/暂停</span>
                    </>
                  )}
                </div>

                {m.role === 'user' ? (
                  <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-blue-600 text-white px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap break-words">
                    {m.content}
                  </div>
                ) : (
                  <div className="w-full rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-3.5">
                    <MarkdownRenderer
                      content={m.content}
                      onSaveCodeToDb={onSaveCodeToDb}
                      onSendCodeToRepo={onSendCodeToRepo}
                      repoConnected={repoConnected}
                    />
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Composer */}
      <div className="px-4 pb-4 pt-2 border-t border-slate-200/70 dark:border-slate-800/70 bg-slate-50 dark:bg-slate-950">
        <div className="max-w-3xl mx-auto">
          {canContinuePartial && (
            <div className="mb-2 flex items-center justify-between px-3 py-1.5 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 text-xs text-amber-800 dark:text-amber-300">
              <span>上一条回复已在流式过程中暂停，保留已生成片段。</span>
              <button
                type="button"
                onClick={onResumePartial}
                className="font-semibold underline underline-offset-2 hover:text-amber-950 dark:hover:text-amber-100"
              >
                继续生成
              </button>
            </div>
          )}

          <div className="flex items-end gap-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-2 focus-within:border-blue-600 transition-colors">
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              disabled={conversation.status === 'paused'}
              onChange={(e) => {
                setInput(e.target.value);
                adjustHeight();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              placeholder={
                conversation.status === 'paused'
                  ? '当前会话已暂停，请点击上方“恢复”按钮继续对话'
                  : '输入指令或代码问题（Enter 发送，Shift+Enter 换行）'
              }
              className="flex-1 bg-transparent px-2 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 resize-none max-h-[200px] focus:outline-none disabled:opacity-50"
            />
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!isStreaming && (!input.trim() || conversation.status === 'paused')}
              className={`h-10 px-4 rounded-lg text-sm font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors ${
                isStreaming
                  ? 'bg-amber-600 hover:bg-amber-700 text-white'
                  : 'bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40'
              }`}
            >
              {isStreaming ? (
                <>
                  <Square className="w-3.5 h-3.5 fill-current" />
                  <span>暂停生成</span>
                </>
              ) : (
                <>
                  <Send className="w-3.5 h-3.5" />
                  <span>发送</span>
                </>
              )}
            </button>
          </div>
          <div className="mt-1.5 flex items-center justify-between text-[11px] text-slate-400 dark:text-slate-500 px-1">
            <span>内容由所选大模型流式生成，关键代码请结合实际运行验证。</span>
            {activeModel?.quotaSummary && (
              <span className="hidden sm:inline">{activeModel.quotaSummary}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

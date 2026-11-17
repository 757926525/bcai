import React, { useEffect, useRef, useState } from 'react';
import JSZip from 'jszip';
import {
  ChevronDown,
  ChevronUp,
  Download,
  FileArchive,
  FileCode2,
  FileText,
  GitBranch,
  Image as ImageIcon,
  Paperclip,
  Pause,
  Play,
  Send,
  Square,
  StickyNote,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { MODE_SUGGESTIONS } from '../data/models';
import {
  ChatAttachment,
  ChatMessage,
  Conversation,
  ModelOption,
  ProviderStatusInfo,
} from '../types';
import { formatBytes, formatDateTime, formatTimeShort, loadLocalJson, saveLocalJson, uid } from '../utils/format';
import { MarkdownRenderer } from './MarkdownRenderer';
import { StatusIndicator } from './StatusIndicator';

interface ChatWorkspaceProps {
  conversation: Conversation;
  allConversations: Conversation[];
  activeModel?: ModelOption;
  providerStatus?: ProviderStatusInfo;
  isStreaming: boolean;
  isAdmin: boolean;
  isMobileLayout: boolean;
  onSend: (text: string, attachments?: ChatAttachment[]) => void;
  onStopStream: () => void;
  onTogglePauseSession: () => void;
  onResumePartial: () => void;
  onClearAttachedFile: () => void;
  onSaveCodeToDb: (code: string, lang: string) => void;
  onSendCodeToRepo: (code: string, lang: string) => void;
  repoConnected: boolean;
  onOpenRepoTab: () => void;
  onOpenExportModal: () => void;
  onShowToast: (msg: string) => void;
}

const LS_SCRATCHPAD = 'bcai.scratchpad.v1';

const LANG_EXT_MAP: Record<string, string> = {
  typescript: 'ts',
  ts: 'ts',
  tsx: 'tsx',
  javascript: 'js',
  js: 'js',
  jsx: 'jsx',
  python: 'py',
  py: 'py',
  json: 'json',
  html: 'html',
  css: 'css',
  sql: 'sql',
  bash: 'sh',
  sh: 'sh',
  markdown: 'md',
  md: 'md',
  yaml: 'yml',
  yml: 'yml',
  toml: 'toml',
  rust: 'rs',
  go: 'go',
};

function extractCodeBlocks(markdown: string): Array<{ lang: string; code: string }> {
  const blocks: Array<{ lang: string; code: string }> = [];
  const regex = /```([\w+#.-]*)[^\S\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(markdown)) !== null) {
    blocks.push({ lang: (m[1] || 'txt').trim(), code: m[2].trimEnd() });
  }
  return blocks;
}

export const ChatWorkspace: React.FC<ChatWorkspaceProps> = ({
  conversation,
  allConversations,
  activeModel,
  providerStatus,
  isStreaming,
  isAdmin,
  isMobileLayout,
  onSend,
  onStopStream,
  onTogglePauseSession,
  onResumePartial,
  onClearAttachedFile,
  onSaveCodeToDb,
  onSendCodeToRepo,
  repoConnected,
  onOpenRepoTab,
  onOpenExportModal,
  onShowToast,
}) => {
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [trayOpen, setTrayOpen] = useState(false);
  const [trayTab, setTrayTab] = useState<'scratchpad' | 'downloads' | 'attachments'>('scratchpad');
  const [scratchpad, setScratchpad] = useState<string>(() => loadLocalJson(LS_SCRATCHPAD, ''));

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const touchStartYRef = useRef<number | null>(null);

  useEffect(() => {
    saveLocalJson(LS_SCRATCHPAD, scratchpad);
  }, [scratchpad]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
    if (nearBottom || conversation.messages.length <= 2) {
      el.scrollTop = el.scrollHeight;
    }
  }, [conversation.messages, conversation.id]);

  const adjustHeight = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  };

  const handleSubmit = () => {
    if (isStreaming) {
      onStopStream();
      return;
    }
    const text = input.trim();
    if ((!text && attachments.length === 0) || conversation.status === 'paused') return;
    const sendingAttachments = [...attachments];
    setInput('');
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    onSend(text || (sendingAttachments.some((a) => a.kind === 'image') ? '请分析附带的图片。' : '请分析附带的文件内容。'), sendingAttachments);
  };

  const handleSelectFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const nextList: ChatAttachment[] = [];

    for (const file of Array.from(files)) {
      const isImage = file.type.startsWith('image/');
      if (isImage) {
        if (file.size > 8 * 1024 * 1024) {
          onShowToast(`图片 ${file.name} 超过 8MB 限制`);
          continue;
        }
        const dataUrl = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.readAsDataURL(file);
        });
        nextList.push({
          id: uid(),
          name: file.name,
          mimeType: file.type || 'image/png',
          size: file.size,
          kind: 'image',
          dataUrl,
        });
      } else {
        if (file.size > 2 * 1024 * 1024) {
          onShowToast(`文件 ${file.name} 超过 2MB 文本解析限制`);
          continue;
        }
        const textContent = await file.text();
        nextList.push({
          id: uid(),
          name: file.name,
          mimeType: file.type || 'text/plain',
          size: file.size,
          kind: 'file',
          textContent: textContent.slice(0, 60000),
        });
      }
    }

    if (nextList.length > 0) {
      setAttachments((prev) => [...prev, ...nextList]);
      setTrayTab('attachments');
      setTrayOpen(true);
      onShowToast(`已添加 ${nextList.length} 个文件/图片到对话`);
    }
  };

  const handleDownloadMessageZip = async (msg: ChatMessage) => {
    const zip = new JSZip();
    zip.file('response.md', msg.content || '');
    const blocks = extractCodeBlocks(msg.content || '');
    blocks.forEach((b, idx) => {
      const ext = LANG_EXT_MAP[b.lang.toLowerCase()] || b.lang || 'txt';
      zip.file(`code-${idx + 1}.${ext}`, b.code);
    });
    if (msg.attachments && msg.attachments.length > 0) {
      for (const att of msg.attachments) {
        if (att.kind === 'image' && att.dataUrl) {
          const base64 = att.dataUrl.split(',')[1];
          if (base64) zip.file(`attachments/${att.name}`, base64, { base64: true });
        } else if (att.textContent) {
          zip.file(`attachments/${att.name}`, att.textContent);
        }
      }
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bcai-reply-${msg.id.slice(0, 6)}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    onShowToast('已打包下载回复与代码压缩包 (.zip)');
  };

  const handleDownloadConversationZip = async () => {
    const zip = new JSZip();
    const mdLines: string[] = [`# ${conversation.title}`, `导出时间: ${new Date().toLocaleString('zh-CN')}`, ''];
    let codeCount = 0;

    for (const m of conversation.messages) {
      mdLines.push(`## ${m.role === 'user' ? '用户' : m.modelId || '助手'} (${formatDateTime(m.createdAt)})`);
      mdLines.push(m.content || '');
      mdLines.push('');

      if (m.role === 'assistant') {
        const blocks = extractCodeBlocks(m.content || '');
        for (const b of blocks) {
          codeCount += 1;
          const ext = LANG_EXT_MAP[b.lang.toLowerCase()] || b.lang || 'txt';
          zip.file(`code/snippet-${codeCount}.${ext}`, b.code);
        }
      }
      if (m.attachments) {
        for (const att of m.attachments) {
          if (att.kind === 'image' && att.dataUrl) {
            const base64 = att.dataUrl.split(',')[1];
            if (base64) zip.file(`attachments/${att.name}`, base64, { base64: true });
          } else if (att.textContent) {
            zip.file(`attachments/${att.name}`, att.textContent);
          }
        }
      }
    }
    zip.file('conversation.md', mdLines.join('\n'));
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bcai-session-${conversation.id.slice(0, 6)}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    onShowToast('已打包下载当前会话全部代码与附件 (.zip)');
  };

  const handleDownloadScratchpad = () => {
    if (!scratchpad.trim()) return;
    const blob = new Blob([scratchpad], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bcai-scratchpad-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartYRef.current = e.touches[0]?.clientY ?? null;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartYRef.current === null) return;
    const endY = e.changedTouches[0]?.clientY ?? touchStartYRef.current;
    const deltaY = touchStartYRef.current - endY;
    if (deltaY > 28) {
      setTrayOpen(true);
    } else if (deltaY < -28) {
      setTrayOpen(false);
    }
    touchStartYRef.current = null;
  };

  const lastMessage = conversation.messages[conversation.messages.length - 1];
  const canContinuePartial =
    !isStreaming &&
    conversation.status === 'active' &&
    lastMessage?.role === 'assistant' &&
    lastMessage?.paused;

  const isRepoMode = conversation.mode === 'repo' || Boolean(conversation.repoFullName);

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
      {/* Top Status Bar */}
      <div className="px-3 sm:px-4 py-2 border-b wb-border wb-panel flex flex-wrap items-center justify-between gap-2 text-xs min-w-0">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 min-w-0 flex-1">
          {isRepoMode ? (
            <button
              type="button"
              onClick={onOpenRepoTab}
              className="inline-flex items-center gap-1.5 font-medium wb-accent-text hover:underline truncate max-w-full"
              title="点击切换仓库或分支"
            >
              <GitBranch className="w-3.5 h-3.5 shrink-0" />
              <span className="font-mono truncate">
                {conversation.repoFullName || '757926525/bcai'} / {conversation.repoBranch || 'main'}
              </span>
            </button>
          ) : (
            <span className="font-semibold wb-ink whitespace-nowrap">
              {conversation.mode === 'code' ? 'AI 编程区' : 'AI 对话区'}
            </span>
          )}

          {conversation.attachedFilePath && (
            <span className="inline-flex items-center gap-1 wb-muted font-mono truncate max-w-[200px] sm:max-w-[260px]">
              <FileCode2 className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{conversation.attachedFilePath}</span>
              <button
                type="button"
                onClick={onClearAttachedFile}
                className="wb-muted hover:text-red-600 ml-0.5 shrink-0"
                title="移除当前附带的仓库文件"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </span>
          )}

          <span className="wb-muted tabular-nums hidden sm:inline whitespace-nowrap">
            · 创建 {formatDateTime(conversation.createdAt)}
          </span>
          <span className="wb-muted tabular-nums hidden md:inline whitespace-nowrap">
            · 更新 {formatTimeShort(conversation.updatedAt)}
          </span>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          {activeModel && (
            <div className="hidden lg:flex items-center gap-2 wb-muted">
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
                ? 'border-amber-400 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300'
                : 'wb-border wb-ink hover:opacity-80'
            }`}
          >
            {conversation.status === 'paused' ? (
              <>
                <Play className="w-3.5 h-3.5" />
                <span>已暂停 · 恢复</span>
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
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 sm:px-4 py-4 sm:py-6 min-w-0">
        <div className="max-w-3xl mx-auto space-y-5 min-w-0">
          {conversation.messages.length === 0 ? (
            <div className="py-8 sm:py-12 text-center space-y-5 px-1">
              <div className="space-y-1.5">
                <h1 className="text-xl sm:text-2xl font-semibold wb-ink">
                  {conversation.mode === 'code'
                    ? '编写、重构与调试完整代码'
                    : conversation.mode === 'repo'
                    ? '基于 Git 仓库分支协同编程'
                    : '多模态文件/图片与自由流式对话'}
                </h1>
                <p className="text-xs sm:text-sm wb-muted max-w-lg mx-auto leading-relaxed">
                  支持直接上传代码文件或截图提问、会话中打包下载 ZIP 压缩包与图片，下方工具条可向上拉动展开草稿板与导出面板。
                </p>
              </div>
              <div className="flex flex-col gap-2 max-w-xl mx-auto">
                {MODE_SUGGESTIONS[conversation.mode].map((s, idx) => (
                  <button
                    key={idx}
                    type="button"
                    disabled={conversation.status === 'paused'}
                    onClick={() => onSend(s)}
                    className="text-left px-3.5 sm:px-4 py-3 rounded-xl border wb-border wb-panel hover:border-blue-500 text-xs sm:text-sm wb-ink transition-colors disabled:opacity-50"
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
                className={`flex flex-col min-w-0 ${m.role === 'user' ? 'items-end' : 'items-start'}`}
              >
                <div className="flex flex-wrap items-center gap-2 text-[11px] wb-muted mb-1 px-1 tabular-nums">
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
                  <div className="max-w-[92%] sm:max-w-[85%] rounded-2xl rounded-tr-sm wb-accent px-3.5 sm:px-4 py-2.5 text-sm sm:text-[15px] leading-relaxed whitespace-pre-wrap break-words space-y-2">
                    {m.attachments && m.attachments.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {m.attachments.map((att) =>
                          att.kind === 'image' && att.dataUrl ? (
                            <div key={att.id} className="rounded-lg overflow-hidden border border-white/20 bg-black/20">
                              <img
                                src={att.dataUrl}
                                alt={att.name}
                                className="max-h-44 max-w-[220px] object-contain block"
                              />
                              <div className="px-2 py-1 flex items-center justify-between gap-2 text-[11px] bg-black/30">
                                <span className="truncate max-w-[140px]">{att.name}</span>
                                <a
                                  href={att.dataUrl}
                                  download={att.name}
                                  className="underline hover:opacity-80 shrink-0"
                                >
                                  下载图片
                                </a>
                              </div>
                            </div>
                          ) : (
                            <span
                              key={att.id}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/15 text-xs font-mono"
                            >
                              <FileText className="w-3.5 h-3.5 shrink-0" />
                              <span className="truncate max-w-[180px]">{att.name}</span>
                            </span>
                          )
                        )}
                      </div>
                    )}
                    <div>{m.content}</div>
                  </div>
                ) : (
                  <div className="w-full min-w-0 rounded-xl border wb-border wb-panel px-3.5 sm:px-4 py-3 sm:py-3.5 space-y-2.5">
                    <MarkdownRenderer
                      content={m.content}
                      onSaveCodeToDb={isAdmin ? onSaveCodeToDb : undefined}
                      onSendCodeToRepo={isAdmin ? onSendCodeToRepo : undefined}
                      repoConnected={repoConnected}
                    />
                    {m.content && (
                      <div className="pt-2 border-t wb-border flex flex-wrap items-center justify-between gap-2 text-[11px] wb-muted">
                        <span>{extractCodeBlocks(m.content).length > 0 ? `包含 ${extractCodeBlocks(m.content).length} 个代码块` : '文本回复'}</span>
                        <button
                          type="button"
                          onClick={() => handleDownloadMessageZip(m)}
                          className="inline-flex items-center gap-1 wb-accent-text hover:underline font-medium"
                        >
                          <FileArchive className="w-3.5 h-3.5" />
                          <span>打包下载 ZIP</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Pull-Up Handle + Composer + Bottom Action Toolbar */}
      <div className="border-t wb-border wb-bg px-2.5 sm:px-4 pb-2.5 sm:pb-3.5 pt-1 min-w-0">
        <div className="max-w-3xl mx-auto min-w-0">
          {/* Touch-friendly Pull-Up / Expand Handle */}
          <div
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
            className="flex items-center justify-center py-1 select-none"
          >
            <button
              type="button"
              onClick={() => setTrayOpen((v) => !v)}
              className="inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full text-[11px] wb-muted hover:wb-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              title="向上拉动或点击展开功能抽屉（附件、草稿板、文件与对话下载）"
            >
              <span className="w-6 h-1 rounded-full bg-current opacity-30" />
              {trayOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
              <span>
                {trayOpen
                  ? '向下收起扩展区'
                  : attachments.length > 0
                  ? `向上拉动展开 (${attachments.length} 个附件待发送)`
                  : '向上拉动展开草稿板 / 下载工具'}
              </span>
            </button>
          </div>

          {/* Expandable Pull-Up Panel (Cleanly hidden when collapsed so buttons never crowd!) */}
          {trayOpen && (
            <div className="mb-2 rounded-xl border wb-border wb-panel p-3 space-y-2.5 shadow-sm">
              <div className="flex items-center justify-between gap-2 border-b wb-border pb-2">
                <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
                  <button
                    type="button"
                    onClick={() => setTrayTab('attachments')}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap ${
                      trayTab === 'attachments' ? 'wb-tint wb-accent-text' : 'wb-muted'
                    }`}
                  >
                    已上传文件/图片 ({attachments.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setTrayTab('scratchpad')}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap ${
                      trayTab === 'scratchpad' ? 'wb-tint wb-accent-text' : 'wb-muted'
                    }`}
                  >
                    临时草稿板
                  </button>
                  <button
                    type="button"
                    onClick={() => setTrayTab('downloads')}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap ${
                      trayTab === 'downloads' ? 'wb-tint wb-accent-text' : 'wb-muted'
                    }`}
                  >
                    ZIP 与对话下载
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setTrayOpen(false)}
                  className="p-1 rounded wb-muted hover:wb-ink shrink-0"
                  aria-label="收起扩展区"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              {trayTab === 'attachments' && (
                <div className="space-y-2">
                  {attachments.length === 0 ? (
                    <div className="text-xs wb-muted py-3 text-center">
                      暂无待发送文件。点击下方「上传文件」可选择图片或代码文档一起发送给大模型。
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
                      {attachments.map((att) => (
                        <div
                          key={att.id}
                          className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border wb-border wb-bg text-xs max-w-full"
                        >
                          {att.kind === 'image' && att.dataUrl ? (
                            <img src={att.dataUrl} alt={att.name} className="w-7 h-7 rounded object-cover shrink-0" />
                          ) : (
                            <FileCode2 className="w-4 h-4 wb-accent-text shrink-0" />
                          )}
                          <div className="min-w-0">
                            <div className="font-medium wb-ink truncate max-w-[140px]">{att.name}</div>
                            <div className="text-[10px] wb-muted">{formatBytes(att.size)}</div>
                          </div>
                          <button
                            type="button"
                            onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== att.id))}
                            className="p-1 wb-muted hover:text-red-600 shrink-0"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {trayTab === 'scratchpad' && (
                <div className="space-y-2">
                  <textarea
                    rows={4}
                    value={scratchpad}
                    onChange={(e) => setScratchpad(e.target.value)}
                    placeholder="随时记录提示词草稿、临时代码片段或待提问需求（自动保存在本地）…"
                    className="w-full p-2.5 rounded-lg border wb-border wb-bg text-xs wb-ink font-mono resize-y focus:outline-none"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="wb-muted">{scratchpad.length} 字符</span>
                    <div className="flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        disabled={!scratchpad.trim()}
                        onClick={() => {
                          setInput((prev) => (prev ? `${prev}\n${scratchpad}` : scratchpad));
                          setTrayOpen(false);
                          textareaRef.current?.focus();
                        }}
                        className="h-8 px-2.5 rounded-lg wb-accent text-xs font-medium disabled:opacity-40"
                      >
                        填入输入框
                      </button>
                      <button
                        type="button"
                        disabled={!scratchpad.trim()}
                        onClick={handleDownloadScratchpad}
                        className="h-8 px-2.5 rounded-lg border wb-border wb-ink text-xs disabled:opacity-40"
                      >
                        下载草稿 .txt
                      </button>
                      <button
                        type="button"
                        disabled={!scratchpad}
                        onClick={() => setScratchpad('')}
                        className="h-8 px-2.5 rounded-lg border wb-border wb-muted hover:text-red-600 text-xs disabled:opacity-40"
                      >
                        清空
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {trayTab === 'downloads' && (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={handleDownloadConversationZip}
                    disabled={conversation.messages.length === 0}
                    className="h-9 px-3 rounded-lg wb-accent text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-40"
                  >
                    <FileArchive className="w-3.5 h-3.5" />
                    <span>下载当前对话代码与图片包 (.zip)</span>
                  </button>
                  <button
                    type="button"
                    onClick={onOpenExportModal}
                    disabled={allConversations.length === 0}
                    className="h-9 px-3 rounded-lg border wb-border wb-ink text-xs font-medium inline-flex items-center gap-1.5 hover:opacity-80"
                  >
                    <FileText className="w-3.5 h-3.5" />
                    <span>多选合并导出对话 (.txt)</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Compact attachment badge indicator even when tray collapsed */}
          {!trayOpen && attachments.length > 0 && (
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5 px-1">
              {attachments.map((att) => (
                <span
                  key={att.id}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border wb-border wb-panel text-[11px] wb-ink"
                >
                  {att.kind === 'image' ? <ImageIcon className="w-3 h-3 wb-accent-text" /> : <Paperclip className="w-3 h-3 wb-accent-text" />}
                  <span className="truncate max-w-[120px]">{att.name}</span>
                  <button
                    type="button"
                    onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== att.id))}
                    className="wb-muted hover:text-red-600"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          {canContinuePartial && (
            <div className="mb-2 flex items-center justify-between px-3 py-1.5 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 text-xs text-amber-800 dark:text-amber-300">
              <span>上一条回复已暂停，保留已生成片段。</span>
              <button
                type="button"
                onClick={onResumePartial}
                className="font-semibold underline underline-offset-2 shrink-0 ml-2"
              >
                继续生成
              </button>
            </div>
          )}

          {/* Main Input Box */}
          <div className="flex items-end gap-2 rounded-xl border wb-border wb-panel p-2 focus-within:border-blue-600 transition-colors">
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
                  ? '当前会话已暂停，请点击恢复按钮继续对话'
                  : isMobileLayout
                  ? '输入指令、粘贴代码或上传图文提问…'
                  : '输入指令、代码问题或附带文件图片提问（Enter 发送，Shift+Enter 换行）'
              }
              className="flex-1 min-w-0 bg-transparent px-2 py-2 text-sm wb-ink placeholder:opacity-50 resize-none max-h-[180px] focus:outline-none disabled:opacity-50"
            />
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!isStreaming && ((!input.trim() && attachments.length === 0) || conversation.status === 'paused')}
              className={`h-10 px-3.5 sm:px-4 rounded-lg text-xs sm:text-sm font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors ${
                isStreaming
                  ? 'bg-amber-600 hover:bg-amber-700 text-white'
                  : 'wb-accent disabled:opacity-40'
              }`}
            >
              {isStreaming ? (
                <>
                  <Square className="w-3.5 h-3.5 fill-current" />
                  <span>停止</span>
                </>
              ) : (
                <>
                  <Send className="w-3.5 h-3.5" />
                  <span>发送</span>
                </>
              )}
            </button>
          </div>

          {/* Bottom Toolbar Explicitly BELOW Composer Input: 上传文件 · 下载文件 · 草稿板 · 暂停按钮 */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,.txt,.md,.ts,.tsx,.js,.jsx,.py,.json,.csv,.html,.css,.sql,.toml,.yml,.yaml,.sh"
            onChange={(e) => {
              handleSelectFiles(e.target.files);
              e.target.value = '';
            }}
            className="hidden"
          />

          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 px-0.5">
            <div className="flex items-center gap-1.5 sm:gap-2 overflow-x-auto no-scrollbar max-w-full py-0.5">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="h-9 px-2.5 sm:px-3 rounded-lg border wb-border wb-panel text-xs font-medium wb-ink hover:opacity-80 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <Upload className="w-3.5 h-3.5 wb-accent-text" />
                <span>上传文件</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setTrayTab('downloads');
                  setTrayOpen((prev) => (prev && trayTab === 'downloads' ? false : true));
                }}
                className={`h-9 px-2.5 sm:px-3 rounded-lg border text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                  trayOpen && trayTab === 'downloads' ? 'border-blue-600 wb-tint wb-accent-text' : 'wb-border wb-panel wb-ink'
                }`}
              >
                <Download className="w-3.5 h-3.5 wb-accent-text" />
                <span>下载文件</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setTrayTab('scratchpad');
                  setTrayOpen((prev) => (prev && trayTab === 'scratchpad' ? false : true));
                }}
                className={`h-9 px-2.5 sm:px-3 rounded-lg border text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                  trayOpen && trayTab === 'scratchpad' ? 'border-blue-600 wb-tint wb-accent-text' : 'wb-border wb-panel wb-ink'
                }`}
              >
                <StickyNote className="w-3.5 h-3.5 wb-accent-text" />
                <span>草稿板</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  if (isStreaming) onStopStream();
                  else onTogglePauseSession();
                }}
                className={`h-9 px-2.5 sm:px-3 rounded-lg border text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                  conversation.status === 'paused' || isStreaming
                    ? 'border-amber-400 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300'
                    : 'wb-border wb-panel wb-ink'
                }`}
              >
                {isStreaming ? (
                  <>
                    <Square className="w-3.5 h-3.5 fill-current" />
                    <span>暂停输出</span>
                  </>
                ) : conversation.status === 'paused' ? (
                  <>
                    <Play className="w-3.5 h-3.5" />
                    <span>恢复会话</span>
                  </>
                ) : (
                  <>
                    <Pause className="w-3.5 h-3.5" />
                    <span>暂停</span>
                  </>
                )}
              </button>
            </div>

            {activeModel?.quotaSummary && !isMobileLayout && (
              <span className="hidden md:inline text-[11px] wb-muted truncate max-w-[240px]">
                {activeModel.quotaSummary}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

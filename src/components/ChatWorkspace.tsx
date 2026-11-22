import React, { useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import {
  ChevronDown,
  ChevronUp,
  Download,
  FileArchive,
  FileCode2,
  FileText,
  Image as ImageIcon,
  Paperclip,
  Pause,
  Play,
  Plug,
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
  ConnectorItem,
  Conversation,
  ModelOption,
  ProviderStatusInfo,
} from '../types';
import {
  extractCodeBlocks,
  hasUnclosedCodeFence,
  LANG_EXT_MAP,
  suggestCodeFilename,
} from '../utils/codeBlocks';
import { formatBytes, formatDateTime, formatTimeShort, loadLocalJson, saveLocalJson, uid } from '../utils/format';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ProjectStatusLights, ProjectWritePhase } from './StatusIndicator';

interface ChatWorkspaceProps {
  conversation: Conversation;
  allConversations: Conversation[];
  activeModel?: ModelOption;
  providerStatus?: ProviderStatusInfo;
  isStreaming: boolean;
  writePhase: ProjectWritePhase;
  activeStreamModel?: string;
  streamStartedAt?: number | null;
  autoContinue: boolean;
  onToggleAutoContinue: () => void;
  isAdmin: boolean;
  isMobileLayout: boolean;
  connectors?: ConnectorItem[];
  onSend: (text: string, attachments?: ChatAttachment[]) => void;
  onStopStream: () => void;
  onTogglePauseSession: () => void;
  onResumePartial: () => void;
  onClearAttachedFile: () => void;
  onSaveCodeToDb: (code: string, lang: string, filename?: string) => void;
  onSendCodeToRepo: (code: string, lang: string, filename?: string) => void;
  onSaveCodeToConnector?: (
    connectorId: string,
    filename: string,
    targetDir: string,
    code: string,
    lang: string
  ) => Promise<{ message: string }>;
  onAppendLocalExchange?: (userText: string, assistantText: string) => void;
  repoConnected: boolean;
  onOpenRepoTab: () => void;
  onOpenConnectorsTab?: () => void;
  onOpenExportModal: () => void;
  onShowToast: (msg: string) => void;
}

const LS_SCRATCHPAD = 'bcai.scratchpad.v1';

export const ChatWorkspace: React.FC<ChatWorkspaceProps> = ({
  conversation,
  allConversations,
  activeModel,
  providerStatus,
  isStreaming,
  writePhase,
  activeStreamModel,
  streamStartedAt,
  autoContinue,
  onToggleAutoContinue,
  isAdmin,
  isMobileLayout,
  connectors = [],
  onSend,
  onStopStream,
  onTogglePauseSession,
  onResumePartial,
  onClearAttachedFile,
  onSaveCodeToDb,
  onSendCodeToRepo,
  onSaveCodeToConnector,
  onAppendLocalExchange,
  repoConnected,
  onOpenConnectorsTab,
  onOpenExportModal,
  onShowToast,
}) => {
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [trayOpen, setTrayOpen] = useState(false);
  const [trayTab, setTrayTab] = useState<'scratchpad' | 'downloads' | 'attachments'>('scratchpad');
  const [scratchpad, setScratchpad] = useState<string>(() => loadLocalJson(LS_SCRATCHPAD, ''));

  // Connector save modal state
  const [connectorModalCode, setConnectorModalCode] = useState<{ code: string; lang: string; filename?: string } | null>(null);
  const [selectedConnectorId, setSelectedConnectorId] = useState('');
  const [saveFilename, setSaveFilename] = useState('');
  const [saveTargetDir, setSaveTargetDir] = useState('bcai-code');
  const [savingToConnector, setSavingToConnector] = useState(false);

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

  const openConnectorPicker = (code: string, lang: string, filename?: string) => {
    const ext = LANG_EXT_MAP[lang.toLowerCase()] || lang || 'txt';
    const preferred = connectors.find((c) => c.status === 'connected') || connectors[0];
    setSelectedConnectorId(preferred?.id || '');
    setSaveFilename(filename ? filename.split('/').pop() || `bcai-${Date.now().toString().slice(-5)}.${ext}` : `bcai-${Date.now().toString().slice(-5)}.${ext}`);
    setSaveTargetDir(preferred?.extraConfig || 'bcai-code');
    setConnectorModalCode({ code, lang, filename });
  };

  const handleConfirmConnectorSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!connectorModalCode || !selectedConnectorId || !onSaveCodeToConnector) return;
    setSavingToConnector(true);
    try {
      const res = await onSaveCodeToConnector(
        selectedConnectorId,
        saveFilename.trim() || `snippet-${Date.now()}.txt`,
        saveTargetDir.trim(),
        connectorModalCode.code,
        connectorModalCode.lang
      );
      onShowToast(res.message);
      setConnectorModalCode(null);
    } catch (err: any) {
      onShowToast(err?.message || '存入连接器失败');
    } finally {
      setSavingToConnector(false);
    }
  };

  const tryHandleSaveCommand = async (rawText: string): Promise<boolean> => {
    const match = rawText.match(
      /^(?:\/save|\/存入连接器|(?:请)?(?:帮我)?(?:把|将)?(?:上面|刚才|最新|最后|这段)?的?代码(?:存入|保存到)(?:连接器|网盘|邮箱|仓库连接器)?)(?:\s+(.*))?$/i
    );
    if (!match) return false;

    const latestBlocks = [...conversation.messages]
      .reverse()
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => extractCodeBlocks(m.content || ''));

    if (latestBlocks.length === 0) {
      if (/^\/(?:save|存入连接器)\b/i.test(rawText.trim())) {
        onAppendLocalExchange?.(
          rawText,
          '当前对话中还没有可保存的代码块，请先让 AI 生成代码后再发送 `/save` 或点击代码块右上角的「存入连接器」。'
        );
        return true;
      }
      return false;
    }

    if (!isAdmin) {
      onAppendLocalExchange?.(rawText, '⚠️ 存入连接器功能仅限管理员使用，请先在右上角登录后重试。');
      return true;
    }

    if (connectors.length === 0 || !onSaveCodeToConnector) {
      onAppendLocalExchange?.(
        rawText,
        '当前尚未接入任何连接器。请先进入左侧「连接器中心」添加 Alist / WebDAV / OneDrive / Google Drive / Webhook 连接器并测试连通，之后即可通过 `/save 文件名.ts` 或代码块右上角「存入连接器」直接保存代码。'
      );
      return true;
    }

    const arg = (match[1] || '').trim();
    const latest = latestBlocks[0];
    const ext = LANG_EXT_MAP[latest.lang.toLowerCase()] || latest.lang || 'txt';
    const matchedConn =
      connectors.find((c) => arg && c.name.toLowerCase().includes(arg.toLowerCase())) ||
      connectors.find((c) => c.status === 'connected') ||
      connectors[0];

    const customFile =
      arg && /\.[a-z0-9]{1,8}$/i.test(arg)
        ? arg.split(/\s+/).find((t) => /\.[a-z0-9]{1,8}$/i.test(t)) || latest.filename?.split('/').pop() || `code-${Date.now().toString().slice(-5)}.${ext}`
        : latest.filename?.split('/').pop() || `code-${Date.now().toString().slice(-5)}.${ext}`;

    try {
      const res = await onSaveCodeToConnector(
        matchedConn.id,
        customFile,
        matchedConn.extraConfig || 'bcai-code',
        latest.code,
        latest.lang
      );
      onAppendLocalExchange?.(
        rawText,
        `✅ 已通过对话指令将最近生成的代码（\`${customFile}\`，${latest.code.length} 字符）存入连接器 **${matchedConn.name}**。\n\n- 保存结果：${res.message}\n- 提示：你也可以随时点击任意代码块右上角的 **「存入连接器」** 指定文件名与目录。`
      );
      onShowToast(res.message);
    } catch (err: any) {
      onAppendLocalExchange?.(rawText, `❌ 存入连接器失败：${err?.message || '请检查连接器凭证或网络连通状态'}`);
    }
    return true;
  };

  const handleSubmit = async () => {
    if (isStreaming) {
      onStopStream();
      return;
    }
    const text = input.trim();
    if ((!text && attachments.length === 0) || conversation.status === 'paused') return;

    if (text && attachments.length === 0) {
      const handled = await tryHandleSaveCommand(text);
      if (handled) {
        setInput('');
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
        return;
      }
    }

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
    zip.file('README-reply.md', msg.content || '');
    const blocks = extractCodeBlocks(msg.content || '');
    const usedNames = new Set<string>();
    blocks.forEach((b, idx) => {
      let targetPath = suggestCodeFilename(b.lang, idx, b.filename);
      if (usedNames.has(targetPath)) {
        targetPath = `module-${idx + 1}-${targetPath.split('/').pop()}`;
      }
      usedNames.add(targetPath);
      zip.file(targetPath, b.code);
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
    a.download = `bcai-project-${msg.id.slice(0, 6)}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    onShowToast(`已按目录结构打包下载 ${blocks.length} 个代码文件 (.zip)`);
  };

  const handleDownloadConversationZip = async () => {
    const zip = new JSZip();
    const mdLines: string[] = [`# ${conversation.title}`, `导出时间: ${new Date().toLocaleString('zh-CN')}`, ''];
    const fileMap = new Map<string, string>();
    let unnamedCounter = 0;

    for (const m of conversation.messages) {
      mdLines.push(`## ${m.role === 'user' ? '用户' : m.modelId || '助手'} (${formatDateTime(m.createdAt)})`);
      mdLines.push(m.content || '');
      mdLines.push('');

      if (m.role === 'assistant') {
        const blocks = extractCodeBlocks(m.content || '');
        for (const b of blocks) {
          if (b.filename) {
            fileMap.set(b.filename, b.code);
          } else {
            const name = suggestCodeFilename(b.lang, unnamedCounter++);
            fileMap.set(`code/${name}`, b.code);
          }
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
    for (const [fPath, content] of fileMap.entries()) {
      zip.file(fPath, content);
    }
    zip.file('conversation.md', mdLines.join('\n'));
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bcai-session-${conversation.id.slice(0, 6)}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    onShowToast(`已打包下载项目代码 (${fileMap.size} 个文件) 与会话记录 (.zip)`);
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
  const lastIsAssistant = lastMessage?.role === 'assistant';
  const lastHasUnclosed = lastIsAssistant && hasUnclosedCodeFence(lastMessage?.content || '');

  const canContinuePartial =
    !isStreaming &&
    conversation.status === 'active' &&
    lastIsAssistant &&
    Boolean(lastMessage?.paused || lastMessage?.truncated || lastMessage?.interrupted || lastHasUnclosed);

  // Live metrics for ProjectStatusLights
  const projectMetrics = useMemo(() => {
    const assistantMessages = conversation.messages.filter((m) => m.role === 'assistant');
    const latestAsst = assistantMessages[assistantMessages.length - 1];
    const latestBlocks = latestAsst ? extractCodeBlocks(latestAsst.content || '') : [];
    const sessionBlocks = assistantMessages.flatMap((m) => extractCodeBlocks(m.content || ''));
    const activeBlocks = latestBlocks.length > 0 ? latestBlocks : sessionBlocks;

    const totalCodeLines = activeBlocks.reduce(
      (sum, b) => sum + (b.code ? b.code.split('\n').length : 0),
      0
    );
    const codeFileNames = Array.from(
      new Set(activeBlocks.map((b, i) => suggestCodeFilename(b.lang, i, b.filename)))
    );
    const generatedChars = latestAsst?.content?.length || 0;
    const hasUnclosed = latestAsst ? hasUnclosedCodeFence(latestAsst.content || '') : false;

    return {
      codeBlockCount: activeBlocks.length,
      sessionBlockCount: sessionBlocks.length,
      totalCodeLines,
      codeFileNames,
      generatedChars,
      hasUnclosed,
    };
  }, [conversation.messages]);

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
      {/* Live Project Writing Status Indicator Lights */}
      <ProjectStatusLights
        mode={conversation.mode}
        phase={writePhase}
        isStreaming={isStreaming}
        modelId={conversation.modelId}
        activeStreamModel={activeStreamModel}
        providerStatus={providerStatus}
        streamStartedAt={streamStartedAt}
        codeBlockCount={projectMetrics.codeBlockCount}
        codeFileNames={projectMetrics.codeFileNames}
        totalCodeLines={projectMetrics.totalCodeLines}
        generatedChars={projectMetrics.generatedChars}
        hasUnclosedCode={projectMetrics.hasUnclosed}
        autoContinue={autoContinue}
        onToggleAutoContinue={onToggleAutoContinue}
        onExportProjectZip={handleDownloadConversationZip}
        canExportZip={projectMetrics.sessionBlockCount > 0}
      />

      {/* Messages Viewport */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 sm:px-4 py-3 sm:py-5 min-w-0">
        <div className="max-w-3xl mx-auto space-y-5 min-w-0">
          {conversation.attachedFilePath && (
            <div className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg border wb-border wb-panel text-xs">
              <span className="inline-flex items-center gap-1.5 wb-muted font-mono truncate">
                <FileCode2 className="w-3.5 h-3.5 wb-accent-text shrink-0" />
                <span className="truncate">已附带仓库文件：{conversation.attachedFilePath}</span>
              </span>
              <button
                type="button"
                onClick={onClearAttachedFile}
                className="wb-muted hover:text-red-600 shrink-0 p-0.5"
                title="移除当前附带的仓库文件"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {conversation.messages.length === 0 ? (
            <div className="py-6 sm:py-10 text-center space-y-5 px-1">
              <div className="space-y-1.5">
                <h1 className="text-xl sm:text-2xl font-semibold wb-ink">
                  {conversation.mode === 'code'
                    ? '编写、重构与调试完整项目代码'
                    : conversation.mode === 'repo'
                    ? '基于 Git 仓库分支协同编程'
                    : '多模态文件/图片与自由流式对话'}
                </h1>
                <p className="text-xs sm:text-sm wb-muted max-w-lg mx-auto leading-relaxed">
                  内置实时项目编写状态灯与防中断续写引擎；支持 HTML 在线沙盒预览、按目录导出项目 ZIP、发送{' '}
                  <code className="font-mono">/save</code> 存入连接器。
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
            conversation.messages.map((m) => {
              const blocks = m.role === 'assistant' ? extractCodeBlocks(m.content || '') : [];
              const isStreamingThis = isStreaming && m.id === lastMessage?.id;
              return (
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
                        <span className="text-amber-600 dark:text-amber-400 font-medium">已暂停</span>
                      </>
                    )}
                    {m.truncated && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="text-amber-600 dark:text-amber-400 font-medium">达到输出上限，可续写</span>
                      </>
                    )}
                    {m.interrupted && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="text-red-600 dark:text-red-400 font-medium">流式意外中断，可续写</span>
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
                        isStreamingMessage={isStreamingThis}
                        onSaveCodeToDb={isAdmin ? onSaveCodeToDb : undefined}
                        onSendCodeToRepo={isAdmin ? onSendCodeToRepo : undefined}
                        onSaveCodeToConnector={isAdmin && onSaveCodeToConnector ? openConnectorPicker : undefined}
                        repoConnected={repoConnected}
                      />
                      {m.content && (
                        <div className="pt-2 border-t wb-border flex flex-wrap items-center justify-between gap-2 text-[11px] wb-muted">
                          <span>
                            {blocks.length > 0
                              ? `包含 ${blocks.length} 个代码文件/模块`
                              : `文本回复 · ${m.content.length} 字`}
                          </span>
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
              );
            })
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

          {/* Expandable Pull-Up Panel */}
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
                    <span>打包下载完整项目代码与图片 (.zip)</span>
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
              <span className="inline-flex items-center gap-1.5 min-w-0">
                <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse shrink-0" />
                <span className="truncate">
                  {lastMessage?.interrupted
                    ? '检测到上次流式连接中断，已完整保留已生成内容。'
                    : lastMessage?.truncated
                    ? '长内容已达单轮输出上限，保留前文并可无缝续写。'
                    : lastHasUnclosed
                    ? '检测到代码块尚未闭合，可点击右侧无缝补全剩余代码。'
                    : '上一条回复已暂停，保留已生成片段。'}
                </span>
              </span>
              <button
                type="button"
                onClick={onResumePartial}
                className="font-semibold underline underline-offset-2 shrink-0 ml-2"
              >
                断点续写
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
                  ? '当前会话已暂停，请点击右上角恢复会话继续对话'
                  : isMobileLayout
                  ? '输入编程需求、/save 存代码或上传文件提问…'
                  : '输入编程需求、/save 文件名 存入连接器，或附带文件图片提问（Enter 发送）'
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

          {/* Bottom Toolbar Below Composer */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,.txt,.md,.ts,.tsx,.js,.jsx,.mjs,.cjs,.py,.go,.rs,.java,.c,.cpp,.h,.php,.rb,.vue,.svelte,.json,.jsonc,.csv,.html,.css,.scss,.sql,.toml,.yml,.yaml,.xml,.svg,.sh,.env,.log"
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
                <span>下载项目/文件</span>
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

      {/* Save Code to Connector Picker Modal */}
      {connectorModalCode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-3">
          <div className="w-full max-w-md rounded-xl border wb-border wb-panel shadow-xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b wb-border">
              <div className="flex items-center gap-2 text-sm font-semibold wb-ink">
                <Plug className="w-4 h-4 wb-accent-text" />
                <span>将代码存入连接器</span>
              </div>
              <button
                type="button"
                onClick={() => setConnectorModalCode(null)}
                className="p-1.5 rounded-lg wb-muted hover:wb-ink"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {connectors.length === 0 ? (
              <div className="p-5 space-y-3 text-xs wb-muted">
                <p>当前暂无已保存的连接器。请先在「连接器中心」添加 Alist / WebDAV / OneDrive / Google Drive / Resend 或 Webhook 连接器。</p>
                {onOpenConnectorsTab && (
                  <button
                    type="button"
                    onClick={() => {
                      setConnectorModalCode(null);
                      onOpenConnectorsTab();
                    }}
                    className="h-9 px-4 rounded-lg wb-accent text-xs font-medium"
                  >
                    前往连接器中心
                  </button>
                )}
              </div>
            ) : (
              <form onSubmit={handleConfirmConnectorSave} className="p-4 space-y-3">
                <label className="flex flex-col gap-1 text-xs wb-muted">
                  <span>选择目标连接器</span>
                  <select
                    value={selectedConnectorId}
                    onChange={(e) => {
                      setSelectedConnectorId(e.target.value);
                      const c = connectors.find((x) => x.id === e.target.value);
                      if (c?.extraConfig) setSaveTargetDir(c.extraConfig);
                    }}
                    className="h-10 px-3 rounded-lg border wb-border wb-bg text-xs wb-ink"
                  >
                    {connectors.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.presetKey} · {c.status === 'connected' ? '已连通' : '待探活'})
                      </option>
                    ))}
                  </select>
                </label>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <label className="flex flex-col gap-1 text-xs wb-muted">
                    <span>保存文件名</span>
                    <input
                      type="text"
                      required
                      value={saveFilename}
                      onChange={(e) => setSaveFilename(e.target.value)}
                      className="h-10 px-3 rounded-lg border wb-border wb-bg text-xs font-mono wb-ink"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs wb-muted">
                    <span>目标目录 / 路径前缀</span>
                    <input
                      type="text"
                      value={saveTargetDir}
                      onChange={(e) => setSaveTargetDir(e.target.value)}
                      placeholder="bcai-code"
                      className="h-10 px-3 rounded-lg border wb-border wb-bg text-xs font-mono wb-ink"
                    />
                  </label>
                </div>

                <div className="rounded-lg border wb-border wb-bg p-2.5 text-[11px] font-mono wb-muted max-h-24 overflow-hidden">
                  {connectorModalCode.code.slice(0, 260)}
                  {connectorModalCode.code.length > 260 ? '…' : ''}
                </div>

                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setConnectorModalCode(null)}
                    className="h-9 px-3.5 rounded-lg border wb-border text-xs wb-ink"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={savingToConnector}
                    className="h-9 px-4 rounded-lg wb-accent text-xs font-medium disabled:opacity-50"
                  >
                    {savingToConnector ? '写入中...' : '确认存入连接器'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

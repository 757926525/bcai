import React, { useState } from 'react';
import { Check, Copy, Database, Download, Eye, FileCode2, GitBranch, Plug, X } from 'lucide-react';
import { LANG_EXT_MAP, parseMarkdownSegments } from '../utils/codeBlocks';

interface MarkdownRendererProps {
  content: string;
  isStreamingMessage?: boolean;
  onSaveCodeToDb?: (code: string, lang: string, filename?: string) => void;
  onSendCodeToRepo?: (code: string, lang: string, filename?: string) => void;
  onSaveCodeToConnector?: (code: string, lang: string, filename?: string) => void;
  repoConnected?: boolean;
}

function renderInline(line: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const regex = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;

  while ((m = regex.exec(line)) !== null) {
    if (m.index > last) {
      nodes.push(line.slice(last, m.index));
    }
    const part = m[0];
    if (part.startsWith('`')) {
      nodes.push(
        <code
          key={key++}
          className="font-mono text-[0.875em] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200"
        >
          {part.slice(1, -1)}
        </code>
      );
    } else if (part.startsWith('**')) {
      nodes.push(
        <strong key={key++} className="font-semibold text-slate-900 dark:text-slate-50">
          {part.slice(2, -2)}
        </strong>
      );
    } else {
      const linkMatch = part.match(/^\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)$/);
      if (linkMatch) {
        nodes.push(
          <a
            key={key++}
            href={linkMatch[2]}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 dark:text-blue-400 underline underline-offset-2 hover:text-blue-700"
          >
            {linkMatch[1]}
          </a>
        );
      } else {
        nodes.push(part);
      }
    }
    last = regex.lastIndex;
  }
  if (last < line.length) {
    nodes.push(line.slice(last));
  }
  return nodes;
}

const CodeBlock: React.FC<{
  lang: string;
  filename?: string;
  code: string;
  closed: boolean;
  isStreamingMessage?: boolean;
  onSaveCodeToDb?: (code: string, lang: string, filename?: string) => void;
  onSendCodeToRepo?: (code: string, lang: string, filename?: string) => void;
  onSaveCodeToConnector?: (code: string, lang: string, filename?: string) => void;
  onPreviewHtml?: (code: string, title?: string) => void;
  repoConnected?: boolean;
}> = ({
  lang,
  filename,
  code,
  closed,
  isStreamingMessage,
  onSaveCodeToDb,
  onSendCodeToRepo,
  onSaveCodeToConnector,
  onPreviewHtml,
  repoConnected,
}) => {
  const [copied, setCopied] = useState(false);

  const lineCount = code ? code.split('\n').length : 0;
  const isHtml = lang.toLowerCase() === 'html' || lang.toLowerCase() === 'htm' || Boolean(filename?.endsWith('.html'));

  const handleCopy = () => {
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const handleDownloadSnippet = () => {
    const ext = LANG_EXT_MAP[(lang || '').toLowerCase()] || 'txt';
    const downloadName = filename ? filename.split('/').pop() || `bcai-code.${ext}` : `bcai-code.${ext}`;
    const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="my-3 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden bg-slate-50 dark:bg-slate-900/90">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 border-b border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-slate-900 text-xs text-slate-600 dark:text-slate-400">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${
              closed
                ? 'bg-emerald-500'
                : isStreamingMessage
                ? 'bg-amber-500 animate-pulse'
                : 'bg-red-500'
            }`}
            title={closed ? '代码块完整已闭合' : isStreamingMessage ? '正在流式写入代码…' : '代码块未闭合，可点续写补全'}
          />
          {filename ? (
            <span className="inline-flex items-center gap-1 font-mono text-slate-800 dark:text-slate-200 font-medium truncate max-w-[200px]">
              <FileCode2 className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
              <span className="truncate">{filename}</span>
            </span>
          ) : (
            <span className="font-mono">{lang || 'text'}</span>
          )}
          <span className="text-[11px] opacity-70 tabular-nums">
            {filename ? `${lang || 'text'} · ` : ''}
            {lineCount} 行
          </span>
          {!closed && (
            <span className="text-[11px] text-amber-600 dark:text-amber-400 font-medium">
              {isStreamingMessage ? '编写中…' : '未闭合'}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-1">
          {isHtml && onPreviewHtml && (
            <button
              type="button"
              onClick={() => onPreviewHtml(code, filename || 'HTML 实时预览')}
              className="inline-flex items-center gap-1 px-2 py-1 rounded bg-blue-600/10 hover:bg-blue-600/20 text-blue-700 dark:text-blue-300 font-medium transition-colors whitespace-nowrap shrink-0"
              title="在安全沙盒中实时运行预览 HTML"
            >
              <Eye className="w-3.5 h-3.5" />
              <span>运行预览</span>
            </button>
          )}
          {onSaveCodeToDb && (
            <button
              type="button"
              onClick={() => onSaveCodeToDb(code, lang, filename)}
              className="inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-slate-200/70 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 transition-colors whitespace-nowrap shrink-0"
              title="保存代码片段到数据库"
            >
              <Database className="w-3.5 h-3.5" />
              <span>存至文件库</span>
            </button>
          )}
          {onSendCodeToRepo && repoConnected && (
            <button
              type="button"
              onClick={() => onSendCodeToRepo(code, lang, filename)}
              className="inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-slate-200/70 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 transition-colors whitespace-nowrap shrink-0"
              title="发送到仓库编辑区以提交推送"
            >
              <GitBranch className="w-3.5 h-3.5" />
              <span>推送到仓库</span>
            </button>
          )}
          {onSaveCodeToConnector && (
            <button
              type="button"
              onClick={() => onSaveCodeToConnector(code, lang, filename)}
              className="inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-slate-200/70 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 transition-colors whitespace-nowrap shrink-0"
              title="将代码保存到已连接的连接器（网盘/邮箱/Webhook）"
            >
              <Plug className="w-3.5 h-3.5" />
              <span>存入连接器</span>
            </button>
          )}
          <button
            type="button"
            onClick={handleDownloadSnippet}
            className="inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-slate-200/70 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 transition-colors whitespace-nowrap shrink-0"
            title="下载当前代码块文件"
          >
            <Download className="w-3.5 h-3.5" />
            <span>下载</span>
          </button>
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-slate-200/70 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 transition-colors whitespace-nowrap shrink-0"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copied ? '已复制' : '复制'}</span>
          </button>
        </div>
      </div>
      <pre className="p-3.5 overflow-x-auto text-[13px] leading-relaxed font-mono text-slate-800 dark:text-slate-200">
        <code>{code}</code>
      </pre>
    </div>
  );
};

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
  content,
  isStreamingMessage,
  onSaveCodeToDb,
  onSendCodeToRepo,
  onSaveCodeToConnector,
  repoConnected,
}) => {
  const [previewHtml, setPreviewHtml] = useState<{ code: string; title: string } | null>(null);

  if (!content) {
    return (
      <span className="inline-flex items-center gap-2 text-slate-400 dark:text-slate-500 text-sm">
        <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
        <span>正在连接模型并思考构思中…</span>
      </span>
    );
  }

  const segments = parseMarkdownSegments(content);

  return (
    <>
      <div className="space-y-2 text-[15px] leading-relaxed text-slate-800 dark:text-slate-200">
        {segments.map((seg, idx) => {
          if (seg.type === 'think') {
            return (
              <details
                key={idx}
                open={isStreamingMessage && !seg.closed}
                className="my-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 px-3 py-2 text-sm text-slate-600 dark:text-slate-400"
              >
                <summary className="cursor-pointer font-medium select-none inline-flex items-center gap-2">
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      seg.closed ? 'bg-emerald-500' : 'bg-blue-500 animate-pulse'
                    }`}
                  />
                  <span>{seg.closed ? '思考过程（已完成）' : '正在深度思考中…'}</span>
                </summary>
                <div className="mt-2 whitespace-pre-wrap leading-relaxed">{seg.text}</div>
              </details>
            );
          }

          if (seg.type === 'code') {
            return (
              <CodeBlock
                key={idx}
                lang={seg.lang}
                filename={seg.filename}
                code={seg.code}
                closed={seg.closed}
                isStreamingMessage={isStreamingMessage}
                onSaveCodeToDb={onSaveCodeToDb}
                onSendCodeToRepo={onSendCodeToRepo}
                onSaveCodeToConnector={onSaveCodeToConnector}
                onPreviewHtml={(c, t) => setPreviewHtml({ code: c, title: t || 'HTML 实时预览' })}
                repoConnected={repoConnected}
              />
            );
          }

          // Render structured text lines
          const lines = seg.text.split('\n');
          return (
            <div key={idx} className="space-y-1.5">
              {lines.map((line, lIdx) => {
                const trimmed = line.trim();
                if (!trimmed) return <div key={lIdx} className="h-1" />;
                const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
                if (heading) {
                  const level = heading[1].length;
                  const cls =
                    level <= 2
                      ? 'text-base font-semibold text-slate-900 dark:text-slate-100 mt-3'
                      : 'text-[15px] font-semibold text-slate-900 dark:text-slate-100 mt-2';
                  return (
                    <div key={lIdx} className={cls}>
                      {renderInline(heading[2])}
                    </div>
                  );
                }
                if (/^[-*]\s+/.test(trimmed)) {
                  return (
                    <div key={lIdx} className="pl-4 flex gap-2">
                      <span className="text-slate-400 select-none">•</span>
                      <div className="flex-1">{renderInline(trimmed.replace(/^[-*]\s+/, ''))}</div>
                    </div>
                  );
                }
                if (/^\d+[.)]\s+/.test(trimmed)) {
                  const numMatch = trimmed.match(/^(\d+[.)])\s+(.*)$/);
                  return (
                    <div key={lIdx} className="pl-4 flex gap-2">
                      <span className="font-mono text-xs text-slate-500 pt-1 tabular-nums">{numMatch?.[1]}</span>
                      <div className="flex-1">{renderInline(numMatch?.[2] || '')}</div>
                    </div>
                  );
                }
                return <p key={lIdx}>{renderInline(line)}</p>;
              })}
            </div>
          );
        })}
      </div>

      {/* Sandboxed HTML Live Preview Modal */}
      {previewHtml && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-2 sm:p-4">
          <div className="w-full max-w-4xl h-[82vh] flex flex-col rounded-xl border wb-border wb-panel shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 border-b wb-border">
              <div className="flex items-center gap-2 text-xs sm:text-sm font-semibold wb-ink">
                <span className="w-2 h-2 rounded-full bg-emerald-500" />
                <span>{previewHtml.title}</span>
              </div>
              <button
                type="button"
                onClick={() => setPreviewHtml(null)}
                className="w-8 h-8 rounded-lg flex items-center justify-center wb-muted hover:bg-black/5 dark:hover:bg-white/5"
                aria-label="关闭预览"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <iframe
              title={previewHtml.title}
              srcDoc={previewHtml.code}
              sandbox="allow-scripts"
              className="flex-1 w-full bg-white border-0"
            />
          </div>
        </div>
      )}
    </>
  );
};

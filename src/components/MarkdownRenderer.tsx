import React, { useState } from 'react';
import { Check, Copy, Database, Download, GitBranch, Plug } from 'lucide-react';

interface MarkdownRendererProps {
  content: string;
  onSaveCodeToDb?: (code: string, lang: string) => void;
  onSendCodeToRepo?: (code: string, lang: string) => void;
  onSaveCodeToConnector?: (code: string, lang: string) => void;
  repoConnected?: boolean;
}

type Segment =
  | { type: 'text'; text: string }
  | { type: 'code'; lang: string; code: string }
  | { type: 'think'; text: string };

function parseSegments(src: string): Segment[] {
  const segments: Segment[] = [];
  // Split <think>...</think> and ```lang\n...\n```
  const pattern = /(<think>[\s\S]*?(?:<\/think>|$)|```[\w+#.-]*[^\S\n]*\n?[\s\S]*?(?:```|$))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(src)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', text: src.slice(lastIndex, match.index) });
    }
    const token = match[0];
    if (token.startsWith('<think>')) {
      const inner = token.replace(/^<think>/, '').replace(/<\/think>$/, '').trim();
      segments.push({ type: 'think', text: inner });
    } else {
      const m = token.match(/^```([\w+#.-]*)[^\S\n]*\n?([\s\S]*?)(?:```)?$/);
      segments.push({
        type: 'code',
        lang: (m?.[1] || 'text').trim(),
        code: (m?.[2] || '').replace(/\n$/, ''),
      });
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < src.length) {
    segments.push({ type: 'text', text: src.slice(lastIndex) });
  }
  return segments;
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
  code: string;
  onSaveCodeToDb?: (code: string, lang: string) => void;
  onSendCodeToRepo?: (code: string, lang: string) => void;
  onSaveCodeToConnector?: (code: string, lang: string) => void;
  repoConnected?: boolean;
}> = ({ lang, code, onSaveCodeToDb, onSendCodeToRepo, onSaveCodeToConnector, repoConnected }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const handleDownloadSnippet = () => {
    const extMap: Record<string, string> = {
      typescript: 'ts', ts: 'ts', tsx: 'tsx', javascript: 'js', js: 'js', jsx: 'jsx',
      python: 'py', py: 'py', json: 'json', html: 'html', css: 'css', sql: 'sql',
      bash: 'sh', sh: 'sh', markdown: 'md', md: 'md', yaml: 'yml', yml: 'yml',
      toml: 'toml', rust: 'rs', go: 'go', java: 'java', cpp: 'cpp', c: 'c',
    };
    const ext = extMap[(lang || '').toLowerCase()] || 'txt';
    const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bcai-code.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="my-3 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden bg-slate-50 dark:bg-slate-900/90">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 border-b border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-slate-900 text-xs text-slate-600 dark:text-slate-400">
        <span className="font-mono">{lang || 'text'}</span>
        <div className="flex flex-wrap items-center justify-end gap-1">
          {onSaveCodeToDb && (
            <button
              type="button"
              onClick={() => onSaveCodeToDb(code, lang)}
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
              onClick={() => onSendCodeToRepo(code, lang)}
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
              onClick={() => onSaveCodeToConnector(code, lang)}
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
  onSaveCodeToDb,
  onSendCodeToRepo,
  onSaveCodeToConnector,
  repoConnected,
}) => {
  if (!content) {
    return <span className="text-slate-400 dark:text-slate-500">正在思考生成中…</span>;
  }

  const segments = parseSegments(content);

  return (
    <div className="space-y-2 text-[15px] leading-relaxed text-slate-800 dark:text-slate-200">
      {segments.map((seg, idx) => {
        if (seg.type === 'think') {
          return (
            <details
              key={idx}
              className="my-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 px-3 py-2 text-sm text-slate-600 dark:text-slate-400"
            >
              <summary className="cursor-pointer font-medium select-none">思考过程</summary>
              <div className="mt-2 whitespace-pre-wrap leading-relaxed">{seg.text}</div>
            </details>
          );
        }

        if (seg.type === 'code') {
          return (
            <CodeBlock
              key={idx}
              lang={seg.lang}
              code={seg.code}
              onSaveCodeToDb={onSaveCodeToDb}
              onSendCodeToRepo={onSendCodeToRepo}
              onSaveCodeToConnector={onSaveCodeToConnector}
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
  );
};

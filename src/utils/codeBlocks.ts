export const LANG_EXT_MAP: Record<string, string> = {
  typescript: 'ts',
  ts: 'ts',
  tsx: 'tsx',
  javascript: 'js',
  js: 'js',
  jsx: 'jsx',
  mjs: 'mjs',
  cjs: 'cjs',
  python: 'py',
  py: 'py',
  json: 'json',
  jsonc: 'jsonc',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  sql: 'sql',
  bash: 'sh',
  sh: 'sh',
  zsh: 'sh',
  shell: 'sh',
  markdown: 'md',
  md: 'md',
  yaml: 'yml',
  yml: 'yml',
  toml: 'toml',
  xml: 'xml',
  svg: 'svg',
  rust: 'rs',
  rs: 'rs',
  go: 'go',
  java: 'java',
  kotlin: 'kt',
  swift: 'swift',
  c: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  csharp: 'cs',
  cs: 'cs',
  php: 'php',
  ruby: 'rb',
  rb: 'rb',
  vue: 'vue',
  svelte: 'svelte',
  dockerfile: 'Dockerfile',
  docker: 'Dockerfile',
};

export interface ExtractedCodeBlock {
  lang: string;
  filename?: string;
  code: string;
  closed: boolean;
}

export type MarkdownSegment =
  | { type: 'text'; text: string }
  | { type: 'code'; lang: string; filename?: string; code: string; closed: boolean }
  | { type: 'think'; text: string; closed: boolean };

function sanitizeFilenameCandidate(raw: string): string | undefined {
  const clean = raw
    .trim()
    .replace(/^['"`(<\[]+|['"`>)\]]+$/g, '')
    .replace(/^\/+/, '');
  if (!clean || clean.length > 140) return undefined;
  if (clean.includes('..') || /[\s\\:*?"<>|]/.test(clean)) return undefined;
  if (/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,10}$/.test(clean) || /^(?:Dockerfile|Makefile|README)$/i.test(clean)) {
    return clean;
  }
  return undefined;
}

export function parseCodeFenceInfo(infoRaw: string, codeBody: string): { lang: string; filename?: string } {
  const info = (infoRaw || '').trim();
  let lang = 'text';
  let filename: string | undefined;

  if (info) {
    // Handle patterns like: "tsx src/App.tsx", "ts:src/utils.ts", "typescript title=\"foo.ts\"", "src/App.tsx"
    const colonMatch = info.match(/^([a-zA-Z0-9+#._-]+):([^\s]+)$/);
    if (colonMatch) {
      lang = colonMatch[1].toLowerCase();
      filename = sanitizeFilenameCandidate(colonMatch[2]);
    } else {
      const attrMatch = info.match(/(?:file|filename|path|title)\s*=\s*["']?([^"'\s]+)["']?/i);
      const tokens = info.split(/\s+/).filter(Boolean);
      const firstToken = tokens[0] || 'text';

      const firstAsFile = sanitizeFilenameCandidate(firstToken);
      if (firstAsFile && firstToken.includes('.')) {
        filename = firstAsFile;
        const ext = firstToken.split('.').pop()?.toLowerCase() || 'text';
        lang = ext;
      } else {
        lang = firstToken.toLowerCase();
        if (attrMatch?.[1]) {
          filename = sanitizeFilenameCandidate(attrMatch[1]);
        } else if (tokens.length > 1) {
          for (let i = 1; i < tokens.length; i++) {
            const candidate = sanitizeFilenameCandidate(tokens[i]);
            if (candidate) {
              filename = candidate;
              break;
            }
          }
        }
      }
    }
  }

  // Fallback: inspect first 2 lines of code body for common filepath comments
  if (!filename && codeBody) {
    const firstLines = codeBody.split('\n').slice(0, 2);
    for (const line of firstLines) {
      const commentFile = line.match(
        /^\s*(?:\/\/|#|\/\*|<!--)\s*(?:file(?:path|name)?|path)\s*[:=]\s*([^\s*>-]+)(?:\s*(?:\*\/|-->))?\s*$/i
      );
      if (commentFile?.[1]) {
        const candidate = sanitizeFilenameCandidate(commentFile[1]);
        if (candidate) {
          filename = candidate;
          break;
        }
      }
    }
  }

  return { lang: lang || 'text', filename };
}

export function parseMarkdownSegments(src: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  const pattern = /(<think>[\s\S]*?(?:<\/think>|$)|```[^\n]*\n?[\s\S]*?(?:```|$))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(src)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', text: src.slice(lastIndex, match.index) });
    }
    const token = match[0];
    if (token.startsWith('<think>')) {
      const closed = token.endsWith('</think>');
      const inner = token.replace(/^<think>/, '').replace(/<\/think>$/, '').trim();
      segments.push({ type: 'think', text: inner, closed });
    } else {
      const closed = token.length >= 6 && token.endsWith('```');
      const innerRaw = closed ? token.slice(3, -3) : token.slice(3);
      const nlIdx = innerRaw.indexOf('\n');
      const infoRaw = nlIdx >= 0 ? innerRaw.slice(0, nlIdx) : innerRaw;
      const bodyRaw = nlIdx >= 0 ? innerRaw.slice(nlIdx + 1) : '';
      const code = bodyRaw.replace(/\n$/, '');
      const { lang, filename } = parseCodeFenceInfo(infoRaw, code);
      segments.push({
        type: 'code',
        lang,
        filename,
        code,
        closed,
      });
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < src.length) {
    segments.push({ type: 'text', text: src.slice(lastIndex) });
  }
  return segments;
}

export function extractCodeBlocks(markdown: string): ExtractedCodeBlock[] {
  if (!markdown) return [];
  const segments = parseMarkdownSegments(markdown);
  return segments
    .filter((s): s is Extract<MarkdownSegment, { type: 'code' }> => s.type === 'code')
    .map(({ lang, filename, code, closed }) => ({ lang, filename, code, closed }));
}

export function hasUnclosedCodeFence(markdown: string): boolean {
  if (!markdown) return false;
  const blocks = extractCodeBlocks(markdown);
  return blocks.some((b) => !b.closed);
}

export function hasUnclosedThinkBlock(markdown: string): boolean {
  if (!markdown) return false;
  const openCount = (markdown.match(/<think>/g) || []).length;
  const closeCount = (markdown.match(/<\/think>/g) || []).length;
  return openCount > closeCount;
}

export function suggestCodeFilename(lang: string, index: number, explicitFilename?: string): string {
  if (explicitFilename) return explicitFilename;
  const ext = LANG_EXT_MAP[(lang || '').toLowerCase()] || 'txt';
  if (ext === 'Dockerfile') return index === 0 ? 'Dockerfile' : `Dockerfile.${index + 1}`;
  return `code-${index + 1}.${ext}`;
}

export interface ProjectCompletenessReport {
  incomplete: boolean;
  reason: 'truncated' | 'interrupted' | 'unclosed_fence' | 'unclosed_think' | 'abrupt_end' | 'missing_planned_files' | 'complete';
  detail: string;
  writtenFiles: string[];
  missingFiles: string[];
}

export function analyzeProjectCompleteness(
  markdown: string,
  mode: 'chat' | 'code' | 'repo',
  streamResult?: { truncated?: boolean; interrupted?: boolean; finishReason?: string }
): ProjectCompletenessReport {
  const trimmed = (markdown || '').trim();
  const blocks = extractCodeBlocks(trimmed);
  const writtenFiles = blocks.map((b, i) => suggestCodeFilename(b.lang, i, b.filename));

  if (!trimmed) {
    return {
      incomplete: Boolean(streamResult?.interrupted),
      reason: streamResult?.interrupted ? 'interrupted' : 'complete',
      detail: '尚未生成输出内容',
      writtenFiles,
      missingFiles: [],
    };
  }

  if (streamResult?.truncated) {
    return {
      incomplete: true,
      reason: 'truncated',
      detail: '触发单轮输出长度上限，需继续生成剩余模块',
      writtenFiles,
      missingFiles: [],
    };
  }

  if (streamResult?.interrupted) {
    return {
      incomplete: true,
      reason: 'interrupted',
      detail: '流式传输意外中断，需从断点继续输出',
      writtenFiles,
      missingFiles: [],
    };
  }

  if (hasUnclosedCodeFence(trimmed)) {
    return {
      incomplete: true,
      reason: 'unclosed_fence',
      detail: '存在尚未闭合的代码块，需继续补全收尾',
      writtenFiles,
      missingFiles: [],
    };
  }

  if (hasUnclosedThinkBlock(trimmed)) {
    return {
      incomplete: true,
      reason: 'unclosed_think',
      detail: '思考标签尚未闭合，需继续输出正文代码',
      writtenFiles,
      missingFiles: [],
    };
  }

  // Detect abrupt mid-sentence cut-off in prose after closing a fence (or in code mode)
  const withoutThink = trimmed.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const lastLine = (withoutThink.split('\n').pop() || '').trim();
  const lastIsCodeClose = lastLine === '```';

  if (
    lastLine &&
    !lastIsCodeClose &&
    (/[:,;=\(\{\[\-\/\\]$/.test(lastLine) ||
      /^#{1,4}\s+\S+$/.test(lastLine) ||
      /(?:接下来|继续输出|下面实现|待续|unfinished|to be continued)[：:]?$/i.test(lastLine))
  ) {
    return {
      incomplete: true,
      reason: 'abrupt_end',
      detail: '文本末尾呈现未完待续状态，需自动接续完成',
      writtenFiles,
      missingFiles: [],
    };
  }

  // Detect if the model explicitly listed multiple project files in its intro/tree before code blocks,
  // wrote some of them, and ended right on a code fence or mid-project without finishing the remaining planned files.
  if ((mode === 'code' || mode === 'repo') && blocks.length > 0) {
    const firstFencePos = withoutThink.indexOf('```');
    const introText = firstFencePos > 0 ? withoutThink.slice(0, firstFencePos) : '';
    const lastFenceEnd = withoutThink.lastIndexOf('```');
    const trailingProse = lastFenceEnd >= 0 ? withoutThink.slice(lastFenceEnd + 3).trim() : '';

    // Find explicit project file names mentioned in the intro structure (e.g. src/App.tsx, package.json)
    const plannedSet = new Set<string>();
    const fileMentionRe = /(?:^|[\s`"'(\[├──└│])+((?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9._-]+\.(?:tsx?|jsx?|mjs|cjs|html|css|scss|json|py|go|rs|vue|svelte|sql|yml|yaml))/gm;
    let fm: RegExpExecArray | null;
    while ((fm = fileMentionRe.exec(introText)) !== null) {
      const candidate = fm[1].replace(/^\/+/, '');
      if (candidate && !candidate.includes('..') && candidate.length <= 80) {
        plannedSet.add(candidate);
      }
    }

    const writtenNormalized = new Set(
      writtenFiles.map((f) => f.toLowerCase())
    );
    const writtenBasenames = new Set(
      writtenFiles.map((f) => (f.split('/').pop() || f).toLowerCase())
    );
    const missingFiles = Array.from(plannedSet).filter((pf) => {
      const low = pf.toLowerCase();
      const base = (pf.split('/').pop() || pf).toLowerCase();
      return !writtenNormalized.has(low) && !writtenBasenames.has(base);
    });

    // Only treat as incomplete if there is no concluding prose (stopped right at code block end) and planned files remain
    if (missingFiles.length > 0 && trailingProse.length < 40) {
      return {
        incomplete: true,
        reason: 'missing_planned_files',
        detail: `已规划项目文件尚余 ${missingFiles.length} 个未写出 (${missingFiles.slice(0, 3).join(', ')})`,
        writtenFiles,
        missingFiles,
      };
    }
  }

  return {
    incomplete: false,
    reason: 'complete',
    detail: blocks.length > 0 ? `项目代码已完整写出（共 ${blocks.length} 个模块）` : '回复已完整生成',
    writtenFiles,
    missingFiles: [],
  };
}

/**
 * Strips leading duplicated code fences and overlapping suffix/prefix lines when seamlessly merging
 * an auto-continuation chunk onto existing generated content.
 */
export function trimContinuationPrefix(
  existing: string,
  incomingPrefix: string,
  wasInsideUnclosedFence: boolean,
  wasInsideUnclosedThink: boolean
): string {
  let clean = incomingPrefix;

  if (wasInsideUnclosedThink) {
    clean = clean.replace(/^\s*<think>\s*\n?/, '');
  }

  if (wasInsideUnclosedFence) {
    // Strip redundant opening fence like ```tsx or ```ts src/App.tsx
    clean = clean.replace(/^\s*```[^\n]*\n?/, '');
  }

  // Trim exact character overlap between tail of existing and head of clean (min 18 chars)
  const existingTail = existing.slice(-400);
  const maxCheck = Math.min(existingTail.length, clean.length);
  for (let len = maxCheck; len >= 18; len--) {
    if (existingTail.endsWith(clean.slice(0, len))) {
      clean = clean.slice(len);
      break;
    }
  }

  if (existing && clean && !existing.endsWith('\n') && !clean.startsWith('\n')) {
    if (!wasInsideUnclosedFence || clean.startsWith('```')) {
      clean = '\n' + clean;
    }
  }

  return clean;
}

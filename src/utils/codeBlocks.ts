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
  reason:
    | 'truncated'
    | 'interrupted'
    | 'blocked'
    | 'unclosed_fence'
    | 'unclosed_think'
    | 'abrupt_end'
    | 'missing_planned_files'
    | 'complete';
  detail: string;
  writtenFiles: string[];
  missingFiles: string[];
}

const ABNORMAL_STOP_REASONS = new Set([
  'safety',
  'recitation',
  'blocklist',
  'prohibited_content',
  'content_filter',
  'spii',
  'malformed_function_call',
  'other',
]);

function isNonFileMention(candidate: string): boolean {
  const low = candidate.toLowerCase();
  if (/^(?:e\.g|i\.e|etc\.a|v\d+\.\d+)$/i.test(low)) return true;
  if (/^\d+\.\d+/.test(low)) return true;
  return false;
}

export function analyzeProjectCompleteness(
  markdown: string,
  mode: 'chat' | 'code' | 'repo',
  streamResult?: { truncated?: boolean; interrupted?: boolean; finishReason?: string }
): ProjectCompletenessReport {
  const trimmed = (markdown || '').trim();
  const blocks = extractCodeBlocks(trimmed);
  const writtenFiles = blocks.map((b, i) => suggestCodeFilename(b.lang, i, b.filename));
  const fr = (streamResult?.finishReason || '').trim();
  const frLow = fr.toLowerCase();

  if (frLow && ABNORMAL_STOP_REASONS.has(frLow)) {
    return {
      incomplete: true,
      reason: 'blocked',
      detail: `模型因策略/异常原因中止输出 (${fr})`,
      writtenFiles,
      missingFiles: [],
    };
  }

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

  // Detect incomplete HTML or truncated last code block even when model closed the fence (common in Workers AI)
  if ((mode === 'code' || mode === 'repo') && blocks.length > 0) {
    const lastBlock = blocks[blocks.length - 1];
    const lastCodeTrim = lastBlock.code.trim();
    const isHtmlBlock = lastBlock.lang.toLowerCase() === 'html' || Boolean(lastBlock.filename?.endsWith('.html'));
    if (
      isHtmlBlock &&
      /^(?:<!doctype|<html\b)/i.test(lastCodeTrim) &&
      !/<\/html>\s*$/i.test(lastCodeTrim)
    ) {
      return {
        incomplete: true,
        reason: 'abrupt_end',
        detail: `HTML 模块 (${lastBlock.filename || 'index.html'}) 缺少 </html> 闭合，疑为模型隐式截断`,
        writtenFiles,
        missingFiles: [],
      };
    }

    const tailCodeLine = (lastCodeTrim.split('\n').pop() || '').trim();
    if (
      tailCodeLine &&
      (/(?:其余代码省略|剩余代码略|此处省略|rest of code omitted|implementation continues|todo:\s*complete)/i.test(tailCodeLine) ||
        /[{\(=\\]$/.test(tailCodeLine))
    ) {
      return {
        incomplete: true,
        reason: 'abrupt_end',
        detail: `最后一个代码块 (${suggestCodeFilename(lastBlock.lang, blocks.length - 1, lastBlock.filename)}) 结尾未完整闭合`,
        writtenFiles,
        missingFiles: [],
      };
    }

    const firstFencePos = withoutThink.indexOf('```');
    const introText = firstFencePos > 0 ? withoutThink.slice(0, firstFencePos) : '';
    const lastFenceEnd = withoutThink.lastIndexOf('```');
    const trailingProse = lastFenceEnd >= 0 ? withoutThink.slice(lastFenceEnd + 3).trim() : '';

    // Find explicit project file names mentioned in the intro structure (e.g. src/App.tsx, package.json)
    const plannedSet = new Set<string>();
    const fileMentionRe =
      /(?:^|[\s`"'(\[├──└│])+((?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9._-]+\.(?:tsx?|jsx?|mjs|cjs|html|css|scss|json|py|go|rs|vue|svelte|sql|yml|yaml))/gm;
    let fm: RegExpExecArray | null;
    while ((fm = fileMentionRe.exec(introText)) !== null) {
      const candidate = fm[1].replace(/^\/+/, '');
      if (candidate && !candidate.includes('..') && candidate.length <= 80 && !isNonFileMention(candidate)) {
        plannedSet.add(candidate);
      }
    }

    const writtenNormalized = new Set(writtenFiles.map((f) => f.toLowerCase()));
    const writtenBasenames = new Set(writtenFiles.map((f) => (f.split('/').pop() || f).toLowerCase()));
    const missingFiles = Array.from(plannedSet).filter((pf) => {
      const low = pf.toLowerCase();
      const base = (pf.split('/').pop() || pf).toLowerCase();
      return !writtenNormalized.has(low) && !writtenBasenames.has(base);
    });

    // Trigger continuation if planned project files remain and trailing prose looks short/non-concluding
    if (missingFiles.length > 0 && trailingProse.length < 60) {
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
 * Builds a clean continuation context tail without breaking Markdown fence parity in the middle of an earlier block.
 */
export function buildCleanContinuationTail(
  markdown: string,
  maxChars = 14000
): { tailText: string; fenceStateNote: string } {
  const blocks = extractCodeBlocks(markdown);
  const lastBlock = blocks[blocks.length - 1];
  const insideOpenFence = Boolean(lastBlock && !lastBlock.closed);

  if (markdown.length <= maxChars) {
    return {
      tailText: markdown,
      fenceStateNote: insideOpenFence
        ? `当前光标正处于未闭合代码块内部（文件/语言：${lastBlock.filename || lastBlock.lang}），请直接继续编写后续代码行并在末尾用 \`\`\` 闭合，切勿重复开头。`
        : '前文所有代码块均已闭合，请直接从下一个未写出的模块/文件或收尾说明继续输出。',
    };
  }

  let cutStart = markdown.length - maxChars;
  // Find nearest newline after cutStart
  const nlAfter = markdown.indexOf('\n', cutStart);
  if (nlAfter > cutStart && nlAfter - cutStart < 600) {
    cutStart = nlAfter + 1;
  }

  let tail = markdown.slice(cutStart);
  // Count fence lines inside tail; if parity mismatches insideOpenFence, anchor cleanly at the next fence header or close stale marker
  const fenceMatches = tail.match(/^```/gm) || [];
  const tailHasOddFences = fenceMatches.length % 2 === 1;

  if (insideOpenFence && !tailHasOddFences) {
    const label = lastBlock.filename ? `${lastBlock.lang} ${lastBlock.filename}` : lastBlock.lang;
    tail = `\`\`\`${label}\n// ...（已接续前文部分代码）\n${tail}`;
  } else if (!insideOpenFence && tailHasOddFences) {
    // We started inside an already-closed block; advance to just after its closing ```
    const firstFenceEnd = tail.indexOf('```');
    if (firstFenceEnd >= 0) {
      const nextNl = tail.indexOf('\n', firstFenceEnd + 3);
      if (nextNl >= 0) {
        tail = tail.slice(nextNl + 1);
      }
    }
  }

  return {
    tailText: tail,
    fenceStateNote: insideOpenFence
      ? `当前光标正处于未闭合代码块内部（文件/语言：${lastBlock.filename || lastBlock.lang}），请直接紧接末尾继续输出剩余代码并在写完后用 \`\`\` 闭合，切勿重写前文代码或重开 \`\`\`。`
      : '前文代码块均已闭合，请直接继续生成剩余文件与内容。',
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
    // Strip optional brief preamble line + redundant opening fence like ```tsx or ```ts src/App.tsx
    clean = clean.replace(/^(?:[^\n`]{0,50}[：:]\s*\n)?\s*```[^\n]*\n?/, '');
  }

  // Strip leading ellipsis echoes if model mimicked `...`
  clean = clean.replace(/^\.\.\.\s*\n?/, '');

  // Trim exact character overlap between tail of existing and head of clean (min 18 chars)
  const existingTail = existing.slice(-600);
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

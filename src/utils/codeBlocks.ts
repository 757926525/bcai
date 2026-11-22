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

export function suggestCodeFilename(lang: string, index: number, explicitFilename?: string): string {
  if (explicitFilename) return explicitFilename;
  const ext = LANG_EXT_MAP[(lang || '').toLowerCase()] || 'txt';
  if (ext === 'Dockerfile') return index === 0 ? 'Dockerfile' : `Dockerfile.${index + 1}`;
  return `code-${index + 1}.${ext}`;
}

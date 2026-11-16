export interface CFEnv {
  ASSETS?: {
    fetch: (request: Request) => Promise<Response>;
  };
  AI?: {
    run: (model: string, input: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>;
  };
  DB?: {
    prepare: (sql: string) => {
      bind: (...args: unknown[]) => {
        all: <T = Record<string, unknown>>() => Promise<{ results: T[] }>;
        run: () => Promise<{ success: boolean; meta?: unknown }>;
        first: <T = Record<string, unknown>>() => Promise<T | null>;
      };
      all: <T = Record<string, unknown>>() => Promise<{ results: T[] }>;
      run: () => Promise<{ success: boolean; meta?: unknown }>;
    };
  };
  ACCESS_PASSWORD?: string;
  GEMINI_API_KEY?: string;
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  CF_D1_DATABASE_ID?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_BASE_URL?: string;
  GROQ_API_KEY?: string;
  GROQ_BASE_URL?: string;
  OPENROUTER_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_MODELS?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_TOKEN?: string;
  APP_URL?: string;
}

export interface PagesContext {
  request: Request;
  env: CFEnv;
}

export function checkAccess(request: Request, env: CFEnv): Response | null {
  const expected = env.ACCESS_PASSWORD;
  if (!expected) return null;
  const raw = request.headers.get('x-access-password') || '';
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  const cookieHeader = request.headers.get('cookie') || '';
  const hasCookie = cookieHeader.split(';').some((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return false;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try {
      return k === 'aimx_access' && decodeURIComponent(v) === expected;
    } catch {
      return k === 'aimx_access' && v === expected;
    }
  });
  if (decoded === expected || hasCookie) return null;
  return new Response(JSON.stringify({ error: '访问密码无效或未登录，请先在计划登录面板验证。' }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });
}

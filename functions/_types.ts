export interface CFEnv {
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
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_BASE_URL?: string;
  GROQ_API_KEY?: string;
  GROQ_BASE_URL?: string;
  OPENROUTER_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
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
  if (decoded !== expected) {
    return new Response(JSON.stringify({ error: '访问密码无效或未登录，请先在登录面板验证。' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  return null;
}

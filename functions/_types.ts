export interface R2ObjectBody {
  arrayBuffer: () => Promise<ArrayBuffer>;
  text: () => Promise<string>;
  httpMetadata?: { contentType?: string };
}

export interface R2Bucket {
  put: (
    key: string,
    value: ArrayBuffer | Uint8Array | string,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }
  ) => Promise<unknown>;
  get: (key: string) => Promise<R2ObjectBody | null>;
  delete: (key: string) => Promise<void>;
  list: (options?: { prefix?: string; limit?: number }) => Promise<{
    objects: Array<{ key: string; size: number; uploaded: Date }>;
  }>;
}

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
  BUCKET?: R2Bucket;
  ACCESS_PASSWORD?: string;
  GEMINI_API_KEY?: string;
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  CF_D1_DATABASE_ID?: string;
  S3_ENDPOINT?: string;
  S3_REGION?: string;
  S3_BUCKET?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
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
  GITLAB_TOKEN?: string;
  GITEE_TOKEN?: string;
  TARGET_REPO_URL?: string;
  APP_URL?: string;
}

export interface PagesContext {
  request: Request;
  env: CFEnv;
}

export function checkAccess(_request: Request, _env: CFEnv): Response | null {
  // 默认无登录阻挡：公开用户可直接进入对话、编程与绘图工作区；
  // 管理员区（数据库、外接API、仓库、连接器）由管理员会话接口单独校验。
  return null;
}

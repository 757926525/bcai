import express, { type Request, type Response, type NextFunction } from 'express';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import JSZip from 'jszip';
import {
  s3DeleteObject,
  s3GetObject,
  s3ListObjects,
  s3PutObject,
  type S3Config,
} from './functions/_crypto-s3.ts';
import {
  type ExternalDbConfig,
  type ExternalDbProvider,
  dbProviderLabel,
  deleteExternalDbAsset,
  deleteExternalDbAssetByBucketKey,
  fetchExternalDbConversations,
  listExternalDbAssets,
  syncExternalDbConversations,
  testAndInitExternalDb,
  upsertExternalDbAsset,
} from './functions/_db-adapters.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '.data');
const LOCAL_DB_FILE = path.join(DATA_DIR, 'bcai-db.json');
const LEGACY_LOCAL_DB_FILE = path.join(DATA_DIR, 'aimx-db.json');
const D1_CFG_FILE = path.join(DATA_DIR, 'd1-config.json');
const BUCKET_CFG_FILE = path.join(DATA_DIR, 'bucket-config.json');
const ADMIN_AUTH_FILE = path.join(DATA_DIR, 'admin-auth.json');
const CONNECTORS_FILE = path.join(DATA_DIR, 'connectors.json');
const GIT_CFG_FILE = path.join(DATA_DIR, 'git-tokens.json');
const GIT_OAUTH_CFG_FILE = path.join(DATA_DIR, 'git-oauth-config.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Migrate legacy aimx-db.json if needed
if (!fs.existsSync(LOCAL_DB_FILE) && fs.existsSync(LEGACY_LOCAL_DB_FILE)) {
  try {
    fs.copyFileSync(LEGACY_LOCAL_DB_FILE, LOCAL_DB_FILE);
  } catch {
    // ignore
  }
}

interface MediaAssetRecord {
  id: string;
  type: 'image' | 'file';
  name: string;
  mime_type: string;
  size_bytes: number;
  prompt?: string;
  model_id?: string;
  content_data: string;
  repo_path?: string;
  storage_location: 'd1' | 'bucket' | 'local';
  bucket_key?: string;
  created_at: string;
  updated_at: string;
}

interface D1BindingConfig {
  accountId: string;
  databaseId: string;
  apiToken: string;
}

interface AdminAuthStore {
  passwordHash?: string;
  salt?: string;
  sessionSecret: string;
  requireLoginGate?: boolean;
  updatedAt?: string;
}

interface GitOAuthAppEntry {
  clientId?: string;
  clientSecret?: string;
  hostUrl?: string;
}

interface GitOAuthConfigStore {
  siteId?: string;
  github?: GitOAuthAppEntry;
  gitlab?: GitOAuthAppEntry;
  gitee?: GitOAuthAppEntry;
}

interface ChatAttachmentInput {
  id?: string;
  name: string;
  mimeType: string;
  size?: number;
  kind: 'image' | 'file';
  dataUrl?: string;
  textContent?: string;
}

interface IncomingChatMessage {
  role: string;
  content: string;
  attachments?: ChatAttachmentInput[];
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
    }
  } catch {
    // ignore corrupted file
  }
  return fallback;
}

function writeJsonFile(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function getAdminStore(): AdminAuthStore {
  const existing = readJsonFile<AdminAuthStore | null>(ADMIN_AUTH_FILE, null);
  if (existing && existing.sessionSecret) return existing;
  const fresh: AdminAuthStore = {
    sessionSecret: crypto.randomBytes(32).toString('hex'),
  };
  writeJsonFile(ADMIN_AUTH_FILE, fresh);
  return fresh;
}

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

function signAdminSession(secret: string): string {
  const payload = `admin.${Date.now()}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifyAdminSessionToken(token: string | undefined, secret: string): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [role, ts, sig] = parts;
  if (role !== 'admin' || !ts || !sig) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${role}.${ts}`).digest('hex');
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

function hasAnyAdminPassword(): { hasPassword: boolean; usingEnv: boolean; hasCustom: boolean } {
  const envPw = (process.env.ACCESS_PASSWORD || '').trim();
  const store = getAdminStore();
  const hasCustom = Boolean(store.passwordHash && store.salt);
  return {
    hasPassword: Boolean(envPw || hasCustom),
    usingEnv: Boolean(envPw),
    hasCustom,
  };
}

function verifyAdminCredentials(candidate: string): boolean {
  const envPw = (process.env.ACCESS_PASSWORD || '').trim();
  if (envPw && candidate === envPw) return true;
  const store = getAdminStore();
  if (store.passwordHash && store.salt) {
    const hashed = hashPassword(candidate, store.salt);
    if (hashed.length === store.passwordHash.length) {
      return crypto.timingSafeEqual(Buffer.from(hashed), Buffer.from(store.passwordHash));
    }
  }
  return false;
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie || '';
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > -1) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

function isRequestAdmin(req: Request): boolean {
  const store = getAdminStore();
  const cookies = parseCookies(req);
  const headerSession = (req.headers['x-admin-token'] as string) || '';
  if (verifyAdminSessionToken(cookies['bcai_admin'], store.sessionSecret)) return true;
  if (verifyAdminSessionToken(headerSession, store.sessionSecret)) return true;

  // Backward-compatible direct password header if caller passes it
  const rawPw = (req.headers['x-access-password'] as string) || '';
  if (rawPw) {
    let decoded = rawPw;
    try {
      decoded = decodeURIComponent(rawPw);
    } catch {
      decoded = rawPw;
    }
    if (verifyAdminCredentials(decoded)) return true;
  }
  return false;
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (isRequestAdmin(req)) {
    next();
    return;
  }
  res.status(401).json({ error: '此操作仅限管理员，请先在右上角点击“管理员登录”。' });
}

function setIframeCookie(res: Response, name: string, value: string, maxAgeMs = 14 * 24 * 60 * 60 * 1000): void {
  const maxAgeSec = Math.floor(maxAgeMs / 1000);
  res.append(
    'Set-Cookie',
    `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=None; Partitioned`
  );
}

function clearIframeCookie(res: Response, name: string): void {
  res.append('Set-Cookie', `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None; Partitioned`);
}

function assertSafeExternalUrl(rawUrl: string): URL {
  const parsed = new URL(rawUrl.trim());
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅支持 http:// 或 https:// 协议地址');
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.endsWith('.local') ||
    host.startsWith('169.254.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  ) {
    throw new Error('安全策略拦截：禁止访问本地回环或内网地址');
  }
  return parsed;
}

function getDbConfig(): ExternalDbConfig | null {
  if (process.env.CF_ACCOUNT_ID && process.env.CF_D1_DATABASE_ID && process.env.CF_API_TOKEN) {
    return {
      provider: 'd1-http',
      accountId: process.env.CF_ACCOUNT_ID,
      databaseId: process.env.CF_D1_DATABASE_ID,
      apiToken: process.env.CF_API_TOKEN,
    };
  }
  if (process.env.TURSO_URL && process.env.TURSO_AUTH_TOKEN) {
    return {
      provider: 'turso',
      tursoUrl: process.env.TURSO_URL,
      tursoAuthToken: process.env.TURSO_AUTH_TOKEN,
    };
  }
  if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
    return {
      provider: 'supabase',
      supabaseUrl: process.env.SUPABASE_URL,
      supabaseKey: process.env.SUPABASE_KEY,
    };
  }
  if (process.env.NEON_CONNECTION_STRING) {
    return {
      provider: 'neon',
      neonConnectionString: process.env.NEON_CONNECTION_STRING,
    };
  }
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    return {
      provider: 'upstash',
      upstashUrl: process.env.UPSTASH_REDIS_REST_URL,
      upstashToken: process.env.UPSTASH_REDIS_REST_TOKEN,
    };
  }
  const saved = readJsonFile<any>(D1_CFG_FILE, null);
  if (saved) {
    if (saved.provider) return saved as ExternalDbConfig;
    if (saved.accountId && saved.databaseId && saved.apiToken) {
      return {
        provider: 'd1-http',
        accountId: saved.accountId,
        databaseId: saved.databaseId,
        apiToken: saved.apiToken,
      };
    }
  }
  return null;
}

function getBucketConfig(): S3Config | null {
  if (
    process.env.S3_ENDPOINT &&
    process.env.S3_BUCKET &&
    process.env.S3_ACCESS_KEY_ID &&
    process.env.S3_SECRET_ACCESS_KEY
  ) {
    const style = process.env.S3_ADDRESSING_STYLE === 'virtual' ? 'virtual' : process.env.S3_ADDRESSING_STYLE === 'path' ? 'path' : undefined;
    return {
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION || 'auto',
      bucket: process.env.S3_BUCKET,
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      addressingStyle: style,
    };
  }
  const saved = readJsonFile<S3Config | null>(BUCKET_CFG_FILE, null);
  if (saved && saved.endpoint && saved.bucket && saved.accessKeyId && saved.secretAccessKey) {
    return saved;
  }
  return null;
}

function getGitOAuthCredentials(provider: 'github' | 'gitlab' | 'gitee', hostUrlOverride?: string): {
  clientId: string;
  clientSecret: string;
  hostUrl: string;
} {
  const saved = readJsonFile<GitOAuthConfigStore>(GIT_OAUTH_CFG_FILE, {});
  if (provider === 'github') {
    return {
      clientId: (process.env.GITHUB_CLIENT_ID || saved.github?.clientId || '').trim(),
      clientSecret: (process.env.GITHUB_CLIENT_SECRET || saved.github?.clientSecret || '').trim(),
      hostUrl: 'https://github.com',
    };
  }
  if (provider === 'gitlab') {
    return {
      clientId: (process.env.GITLAB_CLIENT_ID || saved.gitlab?.clientId || '').trim(),
      clientSecret: (process.env.GITLAB_CLIENT_SECRET || saved.gitlab?.clientSecret || '').trim(),
      hostUrl: (hostUrlOverride || saved.gitlab?.hostUrl || 'https://gitlab.com').trim().replace(/\/+$/, ''),
    };
  }
  return {
    clientId: (process.env.GITEE_CLIENT_ID || saved.gitee?.clientId || '').trim(),
    clientSecret: (process.env.GITEE_CLIENT_SECRET || saved.gitee?.clientSecret || '').trim(),
    hostUrl: 'https://gitee.com',
  };
}

function signOAuthState(payload: Record<string, unknown>, secret: string): string {
  const raw = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(raw).digest('base64url');
  return `${raw}.${sig}`;
}

function verifyOAuthState(state: string, secret: string): Record<string, any> | null {
  const dot = state.indexOf('.');
  if (dot <= 0) return null;
  const raw = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8')) as Record<string, any>;
  } catch {
    return null;
  }
}

// D1 schema initialization is handled by testAndInitExternalDb in functions/_db-adapters.ts

function getAppUrl(req: Request): string {
  if (process.env.APP_URL && process.env.APP_URL !== 'MY_APP_URL') {
    return process.env.APP_URL.replace(/\/+$/, '');
  }
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
  return `${proto}://${host}`;
}

function getDefaultTargetRepoUrl(): string {
  return (process.env.TARGET_REPO_URL || 'https://github.com/757926525/bcai').trim();
}

function parseRepoSlug(repoInput: string): string {
  const clean = (repoInput || '').trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!clean) return '757926525/bcai';
  try {
    if (clean.startsWith('http://') || clean.startsWith('https://')) {
      const u = new URL(clean);
      const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/');
      if (parts.length >= 2) return parts.slice(0, 2).join('/');
    }
  } catch {
    // ignore URL parse error
  }
  return clean;
}

function getGitToken(req: Request, provider: 'github' | 'gitlab' | 'gitee'): string {
  const headerToken =
    (req.headers['x-git-token'] as string) ||
    (provider === 'github' ? (req.headers['x-github-token'] as string) : '') ||
    '';
  if (headerToken) return headerToken.trim();
  const bodyToken = (req.body && typeof req.body.token === 'string' ? req.body.token : '') || '';
  if (bodyToken) return bodyToken.trim();

  const savedMap = readJsonFile<Record<string, string>>(GIT_CFG_FILE, {});
  if (savedMap[provider]) return savedMap[provider].trim();

  const cookies = parseCookies(req);
  if (provider === 'github' && cookies['aimx_gh_token']) return cookies['aimx_gh_token'].trim();
  if (provider === 'github') return (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
  if (provider === 'gitlab') return (process.env.GITLAB_TOKEN || '').trim();
  return (process.env.GITEE_TOKEN || '').trim();
}

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function formatMessageTextWithFiles(m: IncomingChatMessage): string {
  let base = m.content || '';
  const files = (m.attachments || []).filter((a) => a.kind === 'file' && a.textContent);
  if (files.length > 0) {
    const fileBlock = files
      .map((f) => `\n\n[附带文件: ${f.name} (${f.mimeType || 'text/plain'})]\n\`\`\`\n${(f.textContent || '').slice(0, 24000)}\n\`\`\``)
      .join('');
    base = `${base}${fileBlock}`.trim();
  }
  return base;
}

function buildOpenAIMessages(messages: IncomingChatMessage[]): Array<{ role: string; content: unknown }> {
  return messages.map((m) => {
    const text = formatMessageTextWithFiles(m);
    const images = (m.attachments || []).filter((a) => a.kind === 'image' && a.dataUrl);
    if (images.length > 0 && m.role === 'user') {
      return {
        role: m.role,
        content: [
          { type: 'text', text: text || '请结合附带的图片进行详细分析。' },
          ...images.map((img) => ({
            type: 'image_url',
            image_url: { url: img.dataUrl },
          })),
        ],
      };
    }
    return { role: m.role, content: text };
  });
}

function formatFriendlyGeminiError(err: any): string {
  const raw = err?.message || String(err || 'Gemini 请求失败');
  if (raw.includes('503') || raw.includes('UNAVAILABLE') || raw.includes('high demand')) {
    return 'Gemini 上游服务当前高负载繁忙 (503)，已自动重试仍繁忙，请稍候片刻再试或切换至 Gemini 3.1 Flash Lite / 其他模型。';
  }
  if (raw.includes('429') || raw.includes('RESOURCE_EXHAUSTED')) {
    return '已触发 Gemini 免费层频率或配额限制 (429)，请稍候 1 分钟再试或切换其他已连通模型。';
  }
  if (raw.includes('404') || raw.includes('NOT_FOUND')) {
    return '所选 Gemini 模型 ID 不可用或已下线 (404)，请切换至 Gemini 4 Hydrogen 或 Gemini 3.1 Flash Lite。';
  }
  if (raw.includes('403') || raw.includes('401') || raw.includes('API_KEY_INVALID')) {
    return 'Gemini API Key 无效或权限不足，请检查后端环境变量 GEMINI_API_KEY 配置。';
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.error?.message) return String(parsed.error.message);
  } catch {
    // ignore
  }
  return raw.slice(0, 260);
}

async function withGeminiRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
  let lastErr: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const msg = String(err?.message || '');
      const retryable = msg.includes('503') || msg.includes('UNAVAILABLE') || msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED');
      if (!retryable || attempt === maxRetries) break;
      await new Promise((r) => setTimeout(r, 750 * (attempt + 1)));
    }
  }
  throw lastErr;
}

function buildGeminiContents(messages: IncomingChatMessage[]): Array<{ role: string; parts: Array<Record<string, unknown>> }> {
  const mapped: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts: Array<Record<string, unknown>> = [];
    const text = formatMessageTextWithFiles(m);
    if (text) {
      parts.push({ text });
    }
    const images = (m.attachments || []).filter((a) => a.kind === 'image' && a.dataUrl);
    for (const img of images) {
      const match = (img.dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        parts.push({
          inlineData: {
            mimeType: match[1],
            data: match[2],
          },
        });
      }
    }
    if (parts.length === 0) continue;
    if (mapped.length === 0 && role === 'model') {
      mapped.push({ role: 'user', parts: [{ text: '请继续。' }] });
    }
    const prev = mapped[mapped.length - 1];
    if (prev && prev.role === role) {
      prev.parts.push(...parts);
    } else {
      mapped.push({ role, parts });
    }
  }
  if (mapped.length === 0) {
    mapped.push({ role: 'user', parts: [{ text: '你好' }] });
  }
  return mapped;
}

async function createServer() {
  const app = express();
  app.use(express.json({ limit: '35mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, brand: 'BCAI', timestamp: new Date().toISOString() });
  });

  // Public environment capability discovery (never exposes secret values)
  app.get('/api/config/public', (req, res) => {
    const dbCfg = getDbConfig();
    const bucketCfg = getBucketConfig();
    const pwInfo = hasAnyAdminPassword();
    const store = getAdminStore();
    const isAdmin = isRequestAdmin(req);
    const ghOAuth = getGitOAuthCredentials('github');
    const glOAuth = getGitOAuthCredentials('gitlab');
    const geOAuth = getGitOAuthCredentials('gitee');

    const openaiModelsRaw = process.env.OPENAI_MODELS || 'gpt-4o-mini';
    const openaiModels = openaiModelsRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    res.json({
      isAdmin,
      hasAdminPassword: pwInfo.hasPassword,
      usingEnvPassword: pwInfo.usingEnv,
      requireLoginGate: Boolean(store.requireLoginGate),
      defaultTargetRepoUrl: getDefaultTargetRepoUrl(),
      appUrl: getAppUrl(req),
      envProviders: {
        workersAi: Boolean(process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN),
        gemini: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'),
        deepseek: Boolean(process.env.DEEPSEEK_API_KEY),
        groq: Boolean(process.env.GROQ_API_KEY),
        openrouter: Boolean(process.env.OPENROUTER_API_KEY),
        openai: Boolean(process.env.OPENAI_API_KEY),
        openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
        openaiModels,
      },
      d1Bound: Boolean(dbCfg),
      dbProvider: dbCfg?.provider || 'local',
      bucketBound: Boolean(bucketCfg),
      githubOAuthConfigured: Boolean(ghOAuth.clientId && ghOAuth.clientSecret),
      gitOAuthProviders: {
        github: Boolean(ghOAuth.clientId && ghOAuth.clientSecret),
        gitlab: Boolean(glOAuth.clientId && glOAuth.clientSecret),
        gitee: Boolean(geOAuth.clientId && geOAuth.clientSecret),
      },
    });
  });

  // ==========================================
  // Admin Auth Routes (Configurable Global Login Gate; Admin Unlocks Admin Tools)
  // ==========================================
  app.post('/api/auth/admin-login', (req, res) => {
    const { password = '' } = req.body as { password?: string };
    const pwInfo = hasAnyAdminPassword();
    const store = getAdminStore();

    if (pwInfo.hasPassword) {
      if (!verifyAdminCredentials(password)) {
        res.status(401).json({ error: '管理员密码错误（可输入后台环境变量 ACCESS_PASSWORD 或管理员自设密码）' });
        return;
      }
    } else if (password.trim()) {
      const salt = crypto.randomBytes(16).toString('hex');
      store.salt = salt;
      store.passwordHash = hashPassword(password.trim(), salt);
      store.updatedAt = new Date().toISOString();
      writeJsonFile(ADMIN_AUTH_FILE, store);
    }

    const token = signAdminSession(store.sessionSecret);
    setIframeCookie(res, 'bcai_admin', token);
    res.json({
      ok: true,
      isAdmin: true,
      adminToken: token,
      hasAdminPassword: hasAnyAdminPassword().hasPassword,
    });
  });

  app.post('/api/auth/admin-logout', (_req, res) => {
    clearIframeCookie(res, 'bcai_admin');
    res.json({ ok: true, isAdmin: false });
  });

  app.post('/api/auth/login-gate', requireAdmin, (req, res) => {
    const { enabled, initialPassword } = req.body as { enabled?: boolean; initialPassword?: string };
    const store = getAdminStore();
    const nextEnabled = Boolean(enabled);

    if (nextEnabled && !hasAnyAdminPassword().hasPassword) {
      const initPw = (initialPassword || '').trim();
      if (initPw.length >= 4) {
        const salt = crypto.randomBytes(16).toString('hex');
        store.salt = salt;
        store.passwordHash = hashPassword(initPw, salt);
      } else {
        res.status(400).json({
          error: '开启全站登录拦截前，请先设定管理员密码（至少 4 位字符），避免锁站后无法验证身份。',
        });
        return;
      }
    }

    store.requireLoginGate = nextEnabled;
    store.updatedAt = new Date().toISOString();
    writeJsonFile(ADMIN_AUTH_FILE, store);
    res.json({
      ok: true,
      requireLoginGate: store.requireLoginGate,
      hasAdminPassword: hasAnyAdminPassword().hasPassword,
      message: store.requireLoginGate
        ? '已开启全站访问限制：未登录管理员将看到登录拦截界面'
        : '已关闭全站访问限制：普通访客可直接进入编程、绘图与对话区',
    });
  });

  app.post('/api/auth/admin-password', requireAdmin, (req, res) => {
    const { newPassword = '', clearCustomPassword = false } = req.body as {
      newPassword?: string;
      clearCustomPassword?: boolean;
    };
    const store = getAdminStore();
    if (clearCustomPassword) {
      delete store.passwordHash;
      delete store.salt;
      store.updatedAt = new Date().toISOString();
      writeJsonFile(ADMIN_AUTH_FILE, store);
      res.json({
        ok: true,
        message: process.env.ACCESS_PASSWORD
          ? '已清除自定义密码，当前仅保留后台环境变量 ACCESS_PASSWORD 登录'
          : '已清除管理员密码',
        hasAdminPassword: hasAnyAdminPassword().hasPassword,
      });
      return;
    }

    const trimmed = newPassword.trim();
    if (trimmed.length < 4) {
      res.status(400).json({ error: '管理员密码长度请至少设置 4 位字符' });
      return;
    }
    const salt = crypto.randomBytes(16).toString('hex');
    store.salt = salt;
    store.passwordHash = hashPassword(trimmed, salt);
    store.updatedAt = new Date().toISOString();
    writeJsonFile(ADMIN_AUTH_FILE, store);
    res.json({
      ok: true,
      message: '管理员密码已更新保存，下次可使用新密码或后台变量密码登录',
      hasAdminPassword: true,
    });
  });

  // Enforce global login gate on AI execution and deploy package routes when toggled ON
  app.use(
    [
      '/api/chat',
      '/api/image',
      '/api/providers/probe',
      '/api/deploy/source-package.zip',
      '/api/deploy/pages-package.zip',
      '/api/deploy/repo-file',
    ],
    (req, res, next) => {
      const store = getAdminStore();
      if (store.requireLoginGate && !isRequestAdmin(req)) {
        res.status(401).json({ error: '工作台已开启管理员登录拦截开关，请先登录管理员后使用。' });
        return;
      }
      next();
    }
  );

  // Real live connectivity probe for providers (never fakes green!)
  app.post('/api/providers/probe', async (req, res) => {
    const {
      providerType,
      source = 'env',
      baseUrl,
      apiKey,
      accountId,
      modelId,
    } = req.body as {
      providerType: string;
      source?: 'env' | 'custom';
      baseUrl?: string;
      apiKey?: string;
      accountId?: string;
      modelId?: string;
    };

    const start = Date.now();
    try {
      if (providerType === 'gemini') {
        const ai = source === 'custom' && apiKey
          ? new GoogleGenAI({ apiKey, httpOptions: { headers: { 'User-Agent': 'aistudio-build' } } })
          : getGeminiClient();
        if (!ai) {
          res.json({ status: 'unconfigured', message: '未配置 GEMINI_API_KEY 环境变量' });
          return;
        }
        const rawProbe = modelId === 'gemini-2.5-flash' ? 'gemini-3.1-flash-lite' : (modelId || 'gemini-3.1-flash-lite');
        const probeModel = rawProbe;
        try {
          const probeRun = () =>
            withGeminiRetry(
              () =>
                ai.models.generateContent({
                  model: probeModel,
                  contents: 'Reply with OK',
                  ...(probeModel.startsWith('gemini-4')
                    ? { config: { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } }
                    : {}),
                }),
              1
            );
          if (probeModel !== 'gemini-3.1-flash-lite') {
            await Promise.race([
              probeRun(),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('503 UNAVAILABLE: probe timeout')), 10000)
              ),
            ]);
          } else {
            await probeRun();
          }
          res.json({ status: 'connected', latencyMs: Date.now() - start, message: `已连通 (${probeModel})` });
        } catch (probeErr: any) {
          const msg = String(probeErr?.message || '');
          // If primary model has a transient 503 spike or slow response, verify with gemini-3.1-flash-lite
          if (probeModel !== 'gemini-3.1-flash-lite' && (msg.includes('503') || msg.includes('timeout') || msg.includes('UNAVAILABLE'))) {
            await ai.models.generateContent({
              model: 'gemini-3.1-flash-lite',
              contents: 'Reply with OK',
            });
            res.json({
              status: 'connected',
              latencyMs: Date.now() - start,
              message: `Gemini API 已连通 (${probeModel} 当前高负载，已自动切至 gemini-3.1-flash-lite)`,
            });
          } else {
            throw probeErr;
          }
        }
        return;
      }

      if (providerType === 'workers-ai') {
        const acc = accountId || process.env.CF_ACCOUNT_ID || '';
        const tok = apiKey || process.env.CF_API_TOKEN || '';
        if (!acc || !tok) {
          res.json({
            status: 'unconfigured',
            message: '未检测到 CF_ACCOUNT_ID / CF_API_TOKEN（部署至 Cloudflare Pages 时可自动使用 env.AI 免费绑定）',
          });
          return;
        }
        const r = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(acc)}/ai/models/search?per_page=1`,
          { headers: { authorization: `Bearer ${tok}` } }
        );
        if (!r.ok) {
          const txt = await r.text();
          res.json({ status: 'error', latencyMs: Date.now() - start, message: `HTTP ${r.status}: ${txt.slice(0, 120)}` });
          return;
        }
        res.json({ status: 'connected', latencyMs: Date.now() - start, message: 'Cloudflare Workers AI 连通正常' });
        return;
      }

      let targetBase = baseUrl || '';
      let token = apiKey || '';
      if (source === 'env') {
        if (providerType === 'deepseek') {
          targetBase = targetBase || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
          token = process.env.DEEPSEEK_API_KEY || '';
        } else if (providerType === 'groq') {
          targetBase = targetBase || process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
          token = process.env.GROQ_API_KEY || '';
        } else if (providerType === 'openrouter') {
          targetBase = targetBase || 'https://openrouter.ai/api/v1';
          token = process.env.OPENROUTER_API_KEY || '';
        } else {
          targetBase = targetBase || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
          token = process.env.OPENAI_API_KEY || '';
        }
      }

      if (!token) {
        res.json({ status: 'unconfigured', message: '未配置 API Key' });
        return;
      }

      const cleanBase = targetBase.replace(/\/+$/, '');
      const modelsUrl = cleanBase.endsWith('/models') ? cleanBase : `${cleanBase}/models`;
      const r = await fetch(modelsUrl, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        const txt = await r.text();
        res.json({ status: 'error', latencyMs: Date.now() - start, message: `HTTP ${r.status}: ${txt.slice(0, 120)}` });
        return;
      }
      const data = (await r.json()) as { data?: Array<{ id: string }> };
      const discovered = Array.isArray(data?.data) ? data.data.slice(0, 20).map((m) => m.id) : [];
      res.json({
        status: 'connected',
        latencyMs: Date.now() - start,
        message: '接口连通正常',
        models: discovered,
      });
    } catch (err: any) {
      res.json({
        status: 'error',
        latencyMs: Date.now() - start,
        message: providerType === 'gemini' ? formatFriendlyGeminiError(err) : err?.message || '网络探测失败',
      });
    }
  });

  // Unified Multimodal SSE Chat Proxy Endpoint
  app.post('/api/chat', async (req, res) => {
    const {
      model,
      messages,
      temperature = 0.7,
      providerType = 'workers-ai',
      source = 'env',
      baseUrl,
      apiKey,
      accountId,
    } = req.body as {
      model: string;
      messages: IncomingChatMessage[];
      temperature?: number;
      providerType?: string;
      source?: 'env' | 'custom';
      baseUrl?: string;
      apiKey?: string;
      accountId?: string;
    };

    if (!model || !Array.isArray(messages)) {
      res.status(400).json({ error: '缺少 model 或 messages 参数' });
      return;
    }

    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) ac.abort();
    });

    const initSseHeaders = () => {
      if (res.headersSent) return;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
    };

    const writeSse = (payload: unknown) => {
      if (ac.signal.aborted || res.writableEnded) return;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    const startHeartbeat = () => {
      if (heartbeatTimer) return;
      heartbeatTimer = setInterval(() => {
        if (ac.signal.aborted || res.writableEnded) {
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          return;
        }
        res.write(': keepalive\n\n');
      }, 7000);
    };
    const stopHeartbeat = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    res.on('close', () => {
      stopHeartbeat();
    });

    try {
      // 1. Google Gemini via @google/genai SDK (supports multimodal images & files natively)
      if (providerType === 'gemini') {
        const ai = source === 'custom' && apiKey
          ? new GoogleGenAI({ apiKey, httpOptions: { headers: { 'User-Agent': 'aistudio-build' } } })
          : getGeminiClient();

        if (!ai) {
          res.status(400).json({ error: '未配置 GEMINI_API_KEY。请在 AI Studio Secrets 或环境变量中设置。' });
          return;
        }

        let effectiveModel = model === 'gemini-2.5-flash' ? 'gemini-4-hydrogen' : model;
        const systemMsg = messages.find((m) => m.role === 'system')?.content;
        const convo = buildGeminiContents(messages);

        const buildGeminiConfig = (targetModel: string) => {
          const isG4 = targetModel.startsWith('gemini-4');
          const cfg: Record<string, unknown> = {
            maxOutputTokens: 32768,
          };
          if (systemMsg) cfg.systemInstruction = systemMsg;
          if (targetModel === 'gemini-4-hydrogen') {
            cfg.thinkingConfig = { thinkingLevel: ThinkingLevel.MEDIUM };
          } else if (!isG4 && typeof temperature === 'number') {
            cfg.temperature = temperature;
          }
          return cfg;
        };

        const openGeminiStream = async (targetModel: string, timeoutMs?: number) => {
          const cfg = buildGeminiConfig(targetModel);
          const run = () =>
            ai.models.generateContentStream({
              model: targetModel,
              contents: convo as any,
              config: Object.keys(cfg).length ? cfg : undefined,
            });
          if (!timeoutMs) {
            return withGeminiRetry(run, 1);
          }
          return Promise.race([
            withGeminiRetry(run, 0),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('503 UNAVAILABLE: Gemini 4 Hydrogen response timeout')), timeoutMs)
            ),
          ]);
        };

        initSseHeaders();
        startHeartbeat();
        writeSse({ meta: { phase: 'connecting', model: effectiveModel } });

        const consumeGeminiStream = async (
          targetModel: string,
          firstChunkTimeoutMs?: number
        ): Promise<{ receivedText: boolean; finishReason?: string }> => {
          const activeStream = await openGeminiStream(targetModel, firstChunkTimeoutMs);
          const iterator = activeStream[Symbol.asyncIterator]();
          let receivedText = false;
          let finishReason: string | undefined;

          if (targetModel.startsWith('gemini-4')) {
            writeSse({ meta: { phase: 'thinking', model: targetModel } });
          }

          while (!ac.signal.aborted) {
            const nextPromise = iterator.next();
            const step =
              !receivedText && firstChunkTimeoutMs
                ? await Promise.race([
                    nextPromise,
                    new Promise<never>((_, reject) =>
                      setTimeout(
                        () => reject(new Error('503 UNAVAILABLE: Gemini first chunk timeout')),
                        firstChunkTimeoutMs
                      )
                    ),
                  ])
                : await nextPromise;

            if (step.done) break;
            const chunk = step.value;
            const candidateFinish = chunk?.candidates?.[0]?.finishReason;
            if (candidateFinish) finishReason = String(candidateFinish);
            const parts = chunk?.candidates?.[0]?.content?.parts;
            const text = Array.isArray(parts) && parts.length > 0
              ? parts
                  .filter((p: any) => !p?.thought)
                  .map((p: any) => (typeof p?.text === 'string' ? p.text : ''))
                  .join('')
              : chunk?.text || '';
            if (text) {
              if (!receivedText) {
                writeSse({ meta: { phase: 'writing', model: targetModel } });
              }
              receivedText = true;
              writeSse({ response: text });
            }
          }

          return { receivedText, finishReason };
        };

        let finishReason: string | undefined;
        try {
          const result = await consumeGeminiStream(
            effectiveModel,
            effectiveModel === 'gemini-4-hydrogen' ? 14000 : undefined
          );
          finishReason = result.finishReason;
        } catch (geminiErr: any) {
          const msg = String(geminiErr?.message || '');
          const isOverloaded =
            msg.includes('503') ||
            msg.includes('UNAVAILABLE') ||
            msg.includes('high demand') ||
            msg.includes('timeout');
          if (effectiveModel === 'gemini-4-hydrogen' && isOverloaded && !ac.signal.aborted) {
            const fromModel = effectiveModel;
            effectiveModel = 'gemini-3.1-flash-lite';
            writeSse({ meta: { phase: 'fallback', fromModel, model: effectiveModel } });
            try {
              const fallbackRes = await consumeGeminiStream(effectiveModel);
              finishReason = fallbackRes.finishReason;
            } catch (fallbackErr: any) {
              writeSse({ error: formatFriendlyGeminiError(fallbackErr) });
            }
          } else if (!ac.signal.aborted) {
            writeSse({ error: formatFriendlyGeminiError(geminiErr) });
          }
        } finally {
          stopHeartbeat();
        }

        if (finishReason === 'MAX_TOKENS') {
          writeSse({ meta: { phase: 'truncated', finishReason, truncated: true, model: effectiveModel } });
        } else {
          writeSse({ meta: { phase: 'done', finishReason: finishReason || 'STOP', model: effectiveModel } });
        }
        if (!res.writableEnded) {
          res.write('data: [DONE]\n\n');
          res.end();
        }
        return;
      }

      // 2. Cloudflare Workers AI REST API
      if (providerType === 'workers-ai' || model.startsWith('@cf/')) {
        const acc = accountId || process.env.CF_ACCOUNT_ID || '';
        const tok = apiKey || process.env.CF_API_TOKEN || '';
        if (!acc || !tok) {
          res.status(400).json({
            error: '未配置 Cloudflare Workers AI 凭证（CF_ACCOUNT_ID / CF_API_TOKEN）。部署到 Cloudflare Pages 后可直接使用免费 env.AI 绑定，也可在设置区填写或切换至 Gemini 等已连通模型。',
          });
          return;
        }

        const formattedMsgs = buildOpenAIMessages(messages);
        const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(acc)}/ai/run/${model}`;
        const callWorkersAi = (maxTokens?: number) =>
          fetch(cfUrl, {
            method: 'POST',
            signal: ac.signal,
            headers: {
              authorization: `Bearer ${tok}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              messages: formattedMsgs,
              temperature,
              stream: true,
              ...(maxTokens ? { max_tokens: maxTokens } : {}),
            }),
          });

        let upstream = await callWorkersAi(8192);
        if (upstream.status === 400) {
          upstream = await callWorkersAi(4096);
          if (upstream.status === 400) {
            upstream = await callWorkersAi(undefined);
          }
        }

        if (!upstream.ok || !upstream.body) {
          const errText = await upstream.text();
          res.status(upstream.status).json({ error: errText || 'Workers AI 请求失败' });
          return;
        }

        initSseHeaders();
        startHeartbeat();
        writeSse({ meta: { phase: 'writing', model } });

        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let sawDone = false;
        let tailBuf = '';
        try {
          while (!ac.signal.aborted) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!res.writableEnded) {
              res.write(value);
            }
            const chunkStr = tailBuf + decoder.decode(value, { stream: true });
            const lines = chunkStr.split('\n');
            tailBuf = lines.pop() || '';
            for (const ln of lines) {
              if (ln.includes('data: [DONE]')) sawDone = true;
            }
          }
          if (tailBuf.includes('[DONE]')) sawDone = true;
        } finally {
          stopHeartbeat();
        }
        if (!sawDone && !ac.signal.aborted && !res.writableEnded) {
          res.write('data: [DONE]\n\n');
        }
        if (!res.writableEnded) res.end();
        return;
      }

      // 3. OpenAI-Compatible Proxy (DeepSeek / Groq / OpenRouter / Custom)
      let targetBase = baseUrl || '';
      let token = apiKey || '';
      if (!token && source === 'env') {
        if (providerType === 'deepseek') {
          targetBase = targetBase || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
          token = process.env.DEEPSEEK_API_KEY || '';
        } else if (providerType === 'groq') {
          targetBase = targetBase || process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
          token = process.env.GROQ_API_KEY || '';
        } else if (providerType === 'openrouter') {
          targetBase = targetBase || 'https://openrouter.ai/api/v1';
          token = process.env.OPENROUTER_API_KEY || '';
        } else {
          targetBase = targetBase || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
          token = process.env.OPENAI_API_KEY || '';
        }
      }

      if (!token) {
        res.status(400).json({ error: `未配置 ${providerType} 的 API Key，请在管理员设置区添加外接 API 或配置环境变量。` });
        return;
      }

      const formattedMsgs = buildOpenAIMessages(messages);
      const cleanBase = targetBase.replace(/\/+$/, '');
      const chatUrl = cleanBase.endsWith('/chat/completions') ? cleanBase : `${cleanBase}/chat/completions`;
      const callOpenAiCompat = (maxTokens?: number) =>
        fetch(chatUrl, {
          method: 'POST',
          signal: ac.signal,
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: formattedMsgs,
            temperature,
            stream: true,
            ...(maxTokens ? { max_tokens: maxTokens } : {}),
          }),
        });

      let upstream = await callOpenAiCompat(8192);
      if (upstream.status === 400) {
        upstream = await callOpenAiCompat(4096);
        if (upstream.status === 400) {
          upstream = await callOpenAiCompat(undefined);
        }
      }

      if (!upstream.ok || !upstream.body) {
        const errText = await upstream.text();
        res.status(upstream.status).json({ error: errText || `上游返回 ${upstream.status}` });
        return;
      }

      initSseHeaders();
      startHeartbeat();
      writeSse({ meta: { phase: 'writing', model } });

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let sawDone = false;
      let tailBuf = '';
      try {
        while (!ac.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!res.writableEnded) {
            res.write(value);
          }
          const chunkStr = tailBuf + decoder.decode(value, { stream: true });
          const lines = chunkStr.split('\n');
          tailBuf = lines.pop() || '';
          for (const ln of lines) {
            if (ln.includes('data: [DONE]')) sawDone = true;
          }
        }
        if (tailBuf.includes('[DONE]')) sawDone = true;
      } finally {
        stopHeartbeat();
      }
      if (!sawDone && !ac.signal.aborted && !res.writableEnded) {
        res.write('data: [DONE]\n\n');
      }
      if (!res.writableEnded) res.end();
    } catch (err: any) {
      stopHeartbeat();
      if (err?.name === 'AbortError') {
        if (!res.writableEnded) res.end();
        return;
      }
      if (!res.headersSent) {
        res.status(500).json({ error: err?.message || '对话服务异常' });
      } else if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: err?.message || '流式传输中断' })}\n\n`);
        res.end();
      }
    }
  });

  // Multi-Engine Image Generation Endpoint (Pollinations Zero-Key / Workers AI / SiliconFlow Kolors / HuggingFace / OpenAI-Compatible)
  app.post('/api/image', async (req, res) => {
    const {
      prompt,
      negativePrompt = '',
      model = 'pollinations:flux',
      providerType: rawProviderType,
      baseUrl = '',
      steps = 4,
      guidance = 7.5,
      seed,
      width = 1024,
      height = 1024,
      enhanceMode: rawEnhanceMode,
      stylePreset = 'none',
      translate = true,
      accountId,
      apiKey,
    } = req.body as {
      prompt: string;
      negativePrompt?: string;
      model?: string;
      providerType?: 'pollinations' | 'workers-ai' | 'siliconflow' | 'huggingface' | 'openai-image';
      baseUrl?: string;
      steps?: number;
      guidance?: number;
      seed?: string | number;
      width?: number;
      height?: number;
      enhanceMode?: 'none' | 'translate' | 'enhance';
      stylePreset?: string;
      translate?: boolean;
      accountId?: string;
      apiKey?: string;
    };

    if (!prompt || !prompt.trim()) {
      res.status(400).json({ error: '请输入画面描述词' });
      return;
    }

    const STYLE_SUFFIXES: Record<string, { pos: string; neg: string }> = {
      photorealistic: {
        pos: 'photorealistic, 8k uhd, natural lighting, cinematic depth of field, sharp focus, shot on 35mm lens',
        neg: 'cartoon, anime, 3d render, painting, artificial skin, blurry, overexposed',
      },
      anime: {
        pos: 'high quality anime illustration, crisp cel shading, vibrant lighting, expressive details, clean lineart',
        neg: 'photorealistic, 3d, deformed hands, extra fingers, muddy colors, lowres',
      },
      '3d-render': {
        pos: 'octane render, 3d studio lighting, smooth subsurface scattering, volumetric light, clean geometric detail',
        neg: 'flat 2d sketch, noise, grainy, blurry, distorted geometry',
      },
      'chinese-ink': {
        pos: 'traditional Chinese ink wash and mineral color painting, poetic atmosphere, delicate brushwork, rice paper texture',
        neg: 'modern neon, 3d plastic, harsh digital noise, cluttered',
      },
      cyberpunk: {
        pos: 'cyberpunk sci-fi atmosphere, glowing neon reflections on wet surfaces, dramatic rim light, high contrast',
        neg: 'daylight flat lighting, washed out, low contrast, blurry',
      },
      'ui-design': {
        pos: 'clean modern studio product photography, minimal composition, soft diffused studio light, high-end industrial design',
        neg: 'cluttered background, messy text, watermark, distorted typography',
      },
      'flat-illustration': {
        pos: 'modern editorial vector illustration, balanced geometric shapes, harmonious color palette, crisp edges',
        neg: 'photorealistic noise, 3d shading, muddy gradients, messy lines',
      },
    };

    const providerType =
      rawProviderType ||
      (model.startsWith('pollinations:') ? 'pollinations' : model.startsWith('@cf/') ? 'workers-ai' : 'pollinations');
    const enhanceMode: 'none' | 'translate' | 'enhance' =
      rawEnhanceMode || (translate ? 'translate' : 'none');

    const w = Math.min(Math.max(Number(width) || 1024, 256), 1536);
    const h = Math.min(Math.max(Number(height) || 1024, 256), 1536);
    const seedNum =
      seed !== undefined && String(seed).trim() !== '' && !Number.isNaN(Number(seed))
        ? Number(seed)
        : undefined;

    let finalPrompt = prompt.trim();
    let finalNegative = (negativePrompt || '').trim();

    try {
      // High-accuracy prompt refinement / translation via Gemini 3.1 Flash Lite (free tier)
      if (enhanceMode !== 'none') {
        const ai = getGeminiClient();
        if (ai) {
          if (enhanceMode === 'enhance') {
            try {
              const tr = await ai.models.generateContent({
                model: 'gemini-3.1-flash-lite',
                contents: `You are an expert visual prompt engineer for FLUX/SDXL/Kolors.
Translate the following user prompt into precise, natural English (or refine it if already English).
CRITICAL RULES:
- Strictly preserve EVERY subject, count, spatial relation, color, action, and any exact quoted text requested by the user.
- Add only fitting lighting, atmosphere, camera/composition, and texture details without altering the user's meaning.
- Output ONLY a single concise paragraph (<= 95 words), no explanations or markdown quotes.
User prompt: ${finalPrompt}`,
              });
              if (tr.text?.trim()) finalPrompt = tr.text.trim().replace(/^["']|["']$/g, '');
            } catch {
              // fallback to raw prompt
            }
          } else if (/[\u4e00-\u9fff]/.test(finalPrompt)) {
            try {
              const tr = await ai.models.generateContent({
                model: 'gemini-3.1-flash-lite',
                contents: `Translate this image generation prompt accurately into concise, vivid English for FLUX/SDXL, preserving all subjects, counts, colors, and details. Output ONLY the English prompt:\n${finalPrompt}`,
              });
              if (tr.text?.trim()) finalPrompt = tr.text.trim().replace(/^["']|["']$/g, '');
            } catch {
              // fallback
            }
          }

          if (finalNegative && /[\u4e00-\u9fff]/.test(finalNegative)) {
            try {
              const trNeg = await ai.models.generateContent({
                model: 'gemini-3.1-flash-lite',
                contents: `Translate this image generation negative prompt into concise comma-separated English tags. Output ONLY the English tags:\n${finalNegative}`,
              });
              if (trNeg.text?.trim()) finalNegative = trNeg.text.trim();
            } catch {
              // fallback
            }
          }
        }
      }

      const preset = STYLE_SUFFIXES[stylePreset];
      if (preset) {
        finalPrompt = `${finalPrompt}, ${preset.pos}`;
        finalNegative = finalNegative ? `${finalNegative}, ${preset.neg}` : preset.neg;
      }

      const sendImageBinary = (buf: Buffer | ArrayBuffer, contentType = 'image/png') => {
        res.setHeader('Content-Type', contentType);
        res.setHeader('x-final-prompt', encodeURIComponent(finalPrompt));
        if (finalNegative) {
          res.setHeader('x-final-negative', encodeURIComponent(finalNegative));
        }
        res.send(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
      };

      // 1. Built-in Zero-Key Pollinations FLUX / Turbo Engine
      if (providerType === 'pollinations') {
        const pollModel = model.replace(/^pollinations:/, '') || 'flux';
        const qs = new URLSearchParams({
          model: pollModel,
          width: String(w),
          height: String(h),
          nologo: 'true',
          enhance: String(enhanceMode === 'enhance'),
        });
        if (seedNum !== undefined) qs.set('seed', String(seedNum));
        if (finalNegative) qs.set('negative_prompt', finalNegative);

        const pollUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(finalPrompt)}?${qs.toString()}`;
        let upstream = await fetch(pollUrl);
        if (upstream.status >= 500 || upstream.status === 429) {
          await new Promise((r) => setTimeout(r, 900));
          upstream = await fetch(pollUrl);
        }
        if (!upstream.ok) {
          const txt = await upstream.text().catch(() => '');
          res.status(upstream.status).json({ error: `Pollinations 绘图服务返回 HTTP ${upstream.status}: ${txt.slice(0, 160)}` });
          return;
        }
        const ctype = upstream.headers.get('content-type') || 'image/jpeg';
        sendImageBinary(await upstream.arrayBuffer(), ctype);
        return;
      }

      // 2. SiliconFlow Kolors (Free Chinese/English Image Generation)
      if (providerType === 'siliconflow') {
        const token = (apiKey || '').trim();
        if (!token) {
          res.status(400).json({ error: '请在外接绘图配置中填写 SiliconFlow API Key' });
          return;
        }
        const target = (baseUrl || 'https://api.siliconflow.cn/v1/images/generations').trim();
        assertSafeExternalUrl(target);
        const upstream = await fetch(target, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: model || 'Kwai-Kolors/Kolors',
            prompt: finalPrompt,
            ...(finalNegative ? { negative_prompt: finalNegative } : {}),
            image_size: `${w}x${h}`,
            num_inference_steps: Math.min(Math.max(Number(steps) || 20, 1), 50),
            guidance_scale: Number(guidance) || 7.5,
            ...(seedNum !== undefined ? { seed: seedNum } : {}),
          }),
        });
        if (!upstream.ok) {
          res.status(upstream.status).json({ error: (await upstream.text()).slice(0, 260) || 'SiliconFlow 绘图失败' });
          return;
        }
        const j = (await upstream.json()) as {
          images?: Array<{ url?: string }>;
          data?: Array<{ url?: string; b64_json?: string }>;
        };
        const imgB64 = j?.data?.[0]?.b64_json;
        if (imgB64) {
          sendImageBinary(Buffer.from(imgB64, 'base64'), 'image/png');
          return;
        }
        const imgUrl = j?.images?.[0]?.url || j?.data?.[0]?.url;
        if (!imgUrl) {
          res.status(500).json({ error: 'SiliconFlow 未返回图像 URL' });
          return;
        }
        assertSafeExternalUrl(imgUrl);
        const imgRes = await fetch(imgUrl);
        if (!imgRes.ok) {
          res.status(502).json({ error: `下载生成结果失败 HTTP ${imgRes.status}` });
          return;
        }
        sendImageBinary(await imgRes.arrayBuffer(), imgRes.headers.get('content-type') || 'image/png');
        return;
      }

      // 3. Hugging Face Inference API
      if (providerType === 'huggingface') {
        const token = (apiKey || '').trim();
        if (!token) {
          res.status(400).json({ error: '请在外接绘图配置中填写 Hugging Face Access Token' });
          return;
        }
        const cleanBase = (baseUrl || 'https://router.huggingface.co/hf-inference/models').trim().replace(/\/+$/, '');
        const cleanModel = model.replace(/^\/+/, '');
        const target = cleanBase.endsWith(cleanModel) ? cleanBase : `${cleanBase}/${cleanModel}`;
        assertSafeExternalUrl(target);
        const upstream = await fetch(target, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            inputs: finalPrompt,
            parameters: {
              ...(finalNegative ? { negative_prompt: finalNegative } : {}),
              width: w,
              height: h,
              num_inference_steps: Math.min(Math.max(Number(steps) || 25, 1), 50),
              guidance_scale: Number(guidance) || 7.5,
              ...(seedNum !== undefined ? { seed: seedNum } : {}),
            },
          }),
        });
        if (!upstream.ok) {
          res.status(upstream.status).json({ error: (await upstream.text()).slice(0, 260) || 'Hugging Face 绘图失败' });
          return;
        }
        sendImageBinary(await upstream.arrayBuffer(), upstream.headers.get('content-type') || 'image/png');
        return;
      }

      // 4. Generic OpenAI /v1/images/generations Compatible API (Together / Fireworks / OneAPI / etc.)
      if (providerType === 'openai-image') {
        const token = (apiKey || '').trim();
        if (!token) {
          res.status(400).json({ error: '请在外接绘图配置中填写兼容接口 API Key' });
          return;
        }
        const cleanBase = (baseUrl || 'https://api.together.xyz/v1/images/generations').trim().replace(/\/+$/, '');
        const target = cleanBase.endsWith('/images/generations') ? cleanBase : `${cleanBase}/images/generations`;
        assertSafeExternalUrl(target);
        const upstream = await fetch(target, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            prompt: finalPrompt,
            size: `${w}x${h}`,
            n: 1,
          }),
        });
        if (!upstream.ok) {
          res.status(upstream.status).json({ error: (await upstream.text()).slice(0, 260) || '外接绘图接口调用失败' });
          return;
        }
        const j = (await upstream.json()) as { data?: Array<{ url?: string; b64_json?: string }> };
        const b64 = j?.data?.[0]?.b64_json;
        if (b64) {
          sendImageBinary(Buffer.from(b64, 'base64'), 'image/png');
          return;
        }
        const imgUrl = j?.data?.[0]?.url;
        if (!imgUrl) {
          res.status(500).json({ error: '外接绘图接口未返回图像数据' });
          return;
        }
        assertSafeExternalUrl(imgUrl);
        const imgRes = await fetch(imgUrl);
        if (!imgRes.ok) {
          res.status(502).json({ error: `下载生成结果失败 HTTP ${imgRes.status}` });
          return;
        }
        sendImageBinary(await imgRes.arrayBuffer(), imgRes.headers.get('content-type') || 'image/png');
        return;
      }

      // 5. Cloudflare Workers AI Image Models
      const acc = accountId || process.env.CF_ACCOUNT_ID || '';
      const tok = apiKey || process.env.CF_API_TOKEN || '';
      if (!acc || !tok) {
        res.status(400).json({
          error: 'Workers AI 需配置 CF_ACCOUNT_ID / CF_API_TOKEN（或先切换至顶部免 Key 的 Pollinations FLUX 免费绘图引擎）。',
        });
        return;
      }

      const input: Record<string, unknown> = { prompt: finalPrompt, num_steps: steps };
      if (!model.includes('flux-1-schnell')) {
        input.width = w;
        input.height = h;
        if (finalNegative) input.negative_prompt = finalNegative;
        if (typeof guidance === 'number' && !Number.isNaN(guidance)) input.guidance = guidance;
      }
      if (seedNum !== undefined) {
        input.seed = seedNum;
      }

      const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(acc)}/ai/run/${model}`;
      const upstream = await fetch(cfUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tok}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(input),
      });

      if (!upstream.ok) {
        const txt = await upstream.text();
        res.status(upstream.status).json({ error: txt || '绘图模型调用失败' });
        return;
      }

      const ctype = upstream.headers.get('content-type') || 'image/png';
      if (ctype.includes('application/json')) {
        const json = (await upstream.json()) as { result?: { image?: string }; image?: string };
        const b64 = json?.result?.image || json?.image;
        if (!b64) {
          res.status(500).json({ error: '未返回有效图像数据' });
          return;
        }
        sendImageBinary(Buffer.from(b64, 'base64'), 'image/png');
        return;
      }

      sendImageBinary(await upstream.arrayBuffer(), ctype);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || '图像生成失败' });
    }
  });

  // ==========================================
  // Multi-Database (Cloudflare D1 / Turso / Supabase / Neon / Upstash + Local Fallback) — Admin Only
  // ==========================================
  app.get('/api/db/status', requireAdmin, async (_req, res) => {
    const cfg = getDbConfig();
    if (!cfg) {
      const local = readJsonFile<{ items: MediaAssetRecord[] }>(LOCAL_DB_FILE, { items: [] });
      res.json({
        mode: 'local-fallback',
        provider: 'local',
        connected: false,
        d1Bound: false,
        label: '未绑定远程数据库（当前使用本地持久化 .data/bcai-db.json）',
        itemCount: local.items.length,
      });
      return;
    }

    try {
      const info = await testAndInitExternalDb(cfg);
      res.json({
        mode: cfg.provider === 'd1-http' ? 'cloudflare-d1-http' : cfg.provider,
        provider: cfg.provider,
        connected: true,
        d1Bound: true,
        label: info.label,
        itemCount: info.count,
      });
    } catch (err: any) {
      res.json({
        mode: cfg.provider === 'd1-http' ? 'cloudflare-d1-http' : cfg.provider,
        provider: cfg.provider,
        connected: false,
        d1Bound: true,
        label: `${dbProviderLabel(cfg.provider)} 连接异常: ${err?.message || '请检查凭证'}`,
        error: err?.message,
      });
    }
  });

  app.post('/api/db/config', requireAdmin, async (req, res) => {
    const body = req.body as Partial<ExternalDbConfig> & { clear?: boolean };

    if (body.clear) {
      if (fs.existsSync(D1_CFG_FILE)) fs.unlinkSync(D1_CFG_FILE);
      res.json({ ok: true, mode: 'local-fallback' });
      return;
    }

    const provider: ExternalDbProvider = (body.provider as ExternalDbProvider) || 'd1-http';
    const cfg: ExternalDbConfig = {
      provider,
      accountId: body.accountId?.trim(),
      databaseId: body.databaseId?.trim(),
      apiToken: body.apiToken?.trim(),
      tursoUrl: body.tursoUrl?.trim(),
      tursoAuthToken: body.tursoAuthToken?.trim(),
      supabaseUrl: body.supabaseUrl?.trim(),
      supabaseKey: body.supabaseKey?.trim(),
      neonConnectionString: body.neonConnectionString?.trim(),
      upstashUrl: body.upstashUrl?.trim(),
      upstashToken: body.upstashToken?.trim(),
    };

    try {
      const info = await testAndInitExternalDb(cfg);
      writeJsonFile(D1_CFG_FILE, cfg);
      res.json({
        ok: true,
        provider,
        mode: provider === 'd1-http' ? 'cloudflare-d1-http' : provider,
        message: `${info.label}（已自动完成表结构校验与初始化）`,
      });
    } catch (err: any) {
      res.status(400).json({ error: `${dbProviderLabel(provider)} 验证失败: ${err?.message || '未知错误'}` });
    }
  });

  app.get('/api/db/items', requireAdmin, async (req, res) => {
    const typeFilter = (req.query.type as string) || '';
    const cfg = getDbConfig();
    if (cfg) {
      try {
        const rows = await listExternalDbAssets(cfg, typeFilter);
        res.json({ mode: cfg.provider === 'd1-http' ? 'cloudflare-d1-http' : cfg.provider, items: rows });
        return;
      } catch (err: any) {
        res.status(500).json({ error: `读取数据库失败: ${err?.message}` });
        return;
      }
    }

    const local = readJsonFile<{ items: MediaAssetRecord[] }>(LOCAL_DB_FILE, { items: [] });
    const items = (typeFilter ? local.items.filter((i) => i.type === typeFilter) : local.items).map((i) => ({
      ...i,
      storage_location: i.storage_location || 'local',
    }));
    res.json({ mode: 'local-fallback', items });
  });

  app.post('/api/db/items', requireAdmin, async (req, res) => {
    const body = req.body as {
      id: string;
      type: 'image' | 'file';
      name: string;
      mimeType: string;
      sizeBytes?: number;
      prompt?: string;
      modelId?: string;
      contentData: string;
      repoPath?: string;
      storageLocation?: 'd1' | 'bucket' | 'local';
      bucketKey?: string;
    };
    const now = new Date().toISOString();
    const cfg = getDbConfig();
    const defaultLoc = cfg ? (cfg.provider === 'd1-http' ? 'd1' : cfg.provider) : 'local';
    const storageLoc = body.storageLocation || defaultLoc;

    const record: MediaAssetRecord = {
      id: body.id || `asset_${Date.now()}`,
      type: body.type || 'file',
      name: body.name || `untitled-${Date.now()}`,
      mime_type: body.mimeType || 'text/plain',
      size_bytes: body.sizeBytes ?? Buffer.byteLength(body.contentData || '', 'utf-8'),
      prompt: body.prompt || '',
      model_id: body.modelId || '',
      content_data: body.contentData || '',
      repo_path: body.repoPath || '',
      storage_location: (storageLoc === 'd1' || storageLoc === 'bucket' || storageLoc === 'local' ? storageLoc : 'd1') as 'd1' | 'bucket' | 'local',
      bucket_key: body.bucketKey || '',
      created_at: now,
      updated_at: now,
    };

    if (cfg) {
      try {
        await upsertExternalDbAsset(cfg, { ...record, storage_location: storageLoc });
        res.json({ ok: true, mode: cfg.provider, storageLocation: storageLoc, item: { ...record, storage_location: storageLoc } });
        return;
      } catch (err: any) {
        res.status(500).json({ error: `写入数据库失败: ${err?.message}` });
        return;
      }
    }

    const local = readJsonFile<{ items: MediaAssetRecord[] }>(LOCAL_DB_FILE, { items: [] });
    const idx = local.items.findIndex((i) => i.id === record.id);
    if (idx >= 0) {
      record.created_at = local.items[idx].created_at;
      local.items[idx] = record;
    } else {
      local.items.unshift(record);
    }
    writeJsonFile(LOCAL_DB_FILE, local);
    res.json({ ok: true, mode: 'local-fallback', storageLocation: record.storage_location, item: record });
  });

  app.delete('/api/db/items/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const cfg = getDbConfig();
    if (cfg) {
      try {
        await deleteExternalDbAsset(cfg, id);
        res.json({ ok: true });
        return;
      } catch (err: any) {
        res.status(500).json({ error: `删除记录失败: ${err?.message}` });
        return;
      }
    }
    const local = readJsonFile<{ items: MediaAssetRecord[] }>(LOCAL_DB_FILE, { items: [] });
    local.items = local.items.filter((i) => i.id !== id);
    writeJsonFile(LOCAL_DB_FILE, local);
    res.json({ ok: true });
  });

  // ==========================================
  // Storage Bucket (Cloudflare R2 / Aliyun OSS / Tencent COS / AWS S3 / MinIO / B2) — Admin Only
  // ==========================================
  app.get('/api/bucket/status', requireAdmin, async (_req, res) => {
    const cfg = getBucketConfig();
    if (!cfg) {
      res.json({
        configured: false,
        connected: false,
        mode: 'unconfigured',
        label: '未绑定对象存储桶（支持 R2 / 阿里云 OSS / 腾讯云 COS / S3 / MinIO）',
      });
      return;
    }
    try {
      const objs = await s3ListObjects(cfg);
      res.json({
        configured: true,
        connected: true,
        mode: 's3-http',
        bucketName: cfg.bucket,
        itemCount: objs.length,
        label: `存储桶已连通 (${cfg.bucket})`,
      });
    } catch (err: any) {
      res.json({
        configured: true,
        connected: false,
        mode: 'error',
        bucketName: cfg.bucket,
        label: `存储桶连接异常: ${err?.message || '请检查 Endpoint / Key'}`,
        error: err?.message,
      });
    }
  });

  app.post('/api/bucket/config', requireAdmin, async (req, res) => {
    const { endpoint, region = 'auto', bucket, accessKeyId, secretAccessKey, addressingStyle, clear } = req.body as {
      endpoint?: string;
      region?: string;
      bucket?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      addressingStyle?: 'path' | 'virtual';
      clear?: boolean;
    };

    if (clear) {
      if (fs.existsSync(BUCKET_CFG_FILE)) fs.unlinkSync(BUCKET_CFG_FILE);
      res.json({ ok: true, message: '已清除存储桶配置' });
      return;
    }

    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
      res.status(400).json({ error: '请填写完整的 S3/R2/OSS/COS Endpoint、Bucket 名称、Access Key ID 与 Secret Access Key' });
      return;
    }

    const cfg: S3Config = {
      endpoint: endpoint.trim(),
      region: (region || 'auto').trim(),
      bucket: bucket.trim(),
      accessKeyId: accessKeyId.trim(),
      secretAccessKey: secretAccessKey.trim(),
      ...(addressingStyle ? { addressingStyle } : {}),
    };

    try {
      const objs = await s3ListObjects(cfg);
      writeJsonFile(BUCKET_CFG_FILE, cfg);
      res.json({
        ok: true,
        bucketName: cfg.bucket,
        itemCount: objs.length,
        message: `存储桶 ${cfg.bucket} 验证并绑定成功`,
      });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || '存储桶验证失败' });
    }
  });

  app.get('/api/bucket/items', requireAdmin, async (req, res) => {
    const prefix = (req.query.prefix as string) || '';
    const cfg = getBucketConfig();
    if (!cfg) {
      res.json({ configured: false, items: [] });
      return;
    }
    try {
      const items = await s3ListObjects(cfg, prefix);
      res.json({ configured: true, items, bucketName: cfg.bucket });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || '读取存储桶列表失败' });
    }
  });

  app.post('/api/bucket/upload', requireAdmin, async (req, res) => {
    const cfg = getBucketConfig();
    if (!cfg) {
      res.status(400).json({ error: '请先绑定对象存储桶（R2 / S3）后再上传' });
      return;
    }
    const { name, mimeType = 'application/octet-stream', contentData, type = 'file', prompt = '', modelId = '' } = req.body as {
      name: string;
      mimeType?: string;
      contentData: string;
      type?: 'image' | 'file';
      prompt?: string;
      modelId?: string;
    };
    if (!name || !contentData) {
      res.status(400).json({ error: '缺少文件名称或文件内容' });
      return;
    }
    try {
      const safeName = name.replace(/[^\w.\-\u4e00-\u9fff]/g, '_');
      const key = `bcai-assets/${Date.now()}-${safeName}`;
      let payloadBytes: Uint8Array;
      const b64Match = contentData.match(/^data:([^;]+);base64,(.+)$/);
      if (b64Match) {
        payloadBytes = new Uint8Array(Buffer.from(b64Match[2], 'base64'));
      } else {
        payloadBytes = new Uint8Array(Buffer.from(contentData, 'utf-8'));
      }
      await s3PutObject(cfg, key, payloadBytes, mimeType);

      // Record metadata in external DB / local with storage_location='bucket'
      const dbCfg = getDbConfig();
      const now = new Date().toISOString();
      const record: MediaAssetRecord = {
        id: `bkt_${Date.now()}`,
        type,
        name,
        mime_type: mimeType,
        size_bytes: payloadBytes.byteLength,
        prompt,
        model_id: modelId,
        content_data: type === 'image' && contentData.length < 300000 ? contentData : `[存储桶对象] ${key}`,
        storage_location: 'bucket',
        bucket_key: key,
        created_at: now,
        updated_at: now,
      };
      if (dbCfg) {
        try {
          await upsertExternalDbAsset(dbCfg, record);
        } catch {
          // ignore DB index write failure if bucket succeeded
        }
      } else {
        const local = readJsonFile<{ items: MediaAssetRecord[] }>(LOCAL_DB_FILE, { items: [] });
        local.items.unshift(record);
        writeJsonFile(LOCAL_DB_FILE, local);
      }

      res.json({ ok: true, key, storageLocation: 'bucket', item: record });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || '上传存储桶失败' });
    }
  });

  app.get('/api/bucket/download', requireAdmin, async (req, res) => {
    const key = (req.query.key as string) || '';
    const cfg = getBucketConfig();
    if (!cfg || !key) {
      res.status(400).json({ error: '缺少存储桶配置或对象 Key' });
      return;
    }
    try {
      const obj = await s3GetObject(cfg, key);
      const fileName = key.split('/').pop() || 'download';
      res.setHeader('Content-Type', obj.contentType);
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
      res.send(Buffer.from(obj.bytes));
    } catch (err: any) {
      res.status(500).json({ error: err?.message || '下载存储桶文件失败' });
    }
  });

  app.delete('/api/bucket/items', requireAdmin, async (req, res) => {
    const key = (req.query.key as string) || '';
    const cfg = getBucketConfig();
    if (!cfg || !key) {
      res.status(400).json({ error: '缺少存储桶配置或对象 Key' });
      return;
    }
    try {
      await s3DeleteObject(cfg, key);
      // Also clean index row if present
      const dbCfg = getDbConfig();
      if (dbCfg) {
        try {
          await deleteExternalDbAssetByBucketKey(dbCfg, key);
        } catch {
          // ignore
        }
      } else {
        const local = readJsonFile<{ items: MediaAssetRecord[] }>(LOCAL_DB_FILE, { items: [] });
        local.items = local.items.filter((i) => i.bucket_key !== key);
        writeJsonFile(LOCAL_DB_FILE, local);
      }
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || '删除存储桶文件失败' });
    }
  });

  // ==========================================
  // Conversation History Sync (Multi-DB + Storage Bucket) — Admin Only
  // ==========================================
  app.post('/api/sync/conversations', requireAdmin, async (req, res) => {
    const { conversations = [], target = 'auto' } = req.body as {
      conversations?: any[];
      target?: 'auto' | 'd1' | 'bucket' | 'both';
    };
    const dbCfg = getDbConfig();
    const bucketCfg = getBucketConfig();

    const wantDb = target === 'd1' || target === 'both' || (target === 'auto' && Boolean(dbCfg));
    const wantBucket = target === 'bucket' || target === 'both' || (target === 'auto' && Boolean(bucketCfg));

    if (!wantDb && !wantBucket) {
      res.status(400).json({
        ok: false,
        error: '尚未绑定远程数据库或对象存储桶，请先完成至少一项绑定后再同步对话历史。',
      });
      return;
    }

    const now = new Date().toISOString();
    const results: { d1: boolean; bucket: boolean; errors: string[] } = {
      d1: false,
      bucket: false,
      errors: [],
    };

    if (wantDb) {
      if (!dbCfg) {
        results.errors.push('未配置远程数据库');
      } else {
        try {
          await syncExternalDbConversations(dbCfg, conversations, now);
          results.d1 = true;
        } catch (err: any) {
          results.errors.push(`数据库同步失败: ${err?.message}`);
        }
      }
    }

    if (wantBucket) {
      if (!bucketCfg) {
        results.errors.push('未配置对象存储桶');
      } else {
        try {
          const payload = JSON.stringify({ syncedAt: now, conversations }, null, 2);
          await s3PutObject(bucketCfg, 'bcai-sync/conversations.json', payload, 'application/json; charset=utf-8');
          results.bucket = true;
        } catch (err: any) {
          results.errors.push(`存储桶同步失败: ${err?.message}`);
        }
      }
    }

    const ok = results.d1 || results.bucket;
    const syncedLabels = [
      results.d1 && dbCfg ? dbProviderLabel(dbCfg.provider) : '',
      results.bucket ? '存储桶' : '',
    ].filter(Boolean);

    res.status(ok ? 200 : 500).json({
      ok,
      syncedAt: now,
      count: conversations.length,
      targets: syncedLabels,
      errors: results.errors,
      message: ok
        ? `已成功同步 ${conversations.length} 个会话至 ${syncedLabels.join(' + ')}`
        : results.errors.join('；'),
    });
  });

  app.get('/api/sync/conversations', requireAdmin, async (req, res) => {
    const source = (req.query.source as string) || 'auto';
    const dbCfg = getDbConfig();
    const bucketCfg = getBucketConfig();

    if ((source === 'bucket' || (source === 'auto' && !dbCfg && bucketCfg)) && bucketCfg) {
      try {
        const obj = await s3GetObject(bucketCfg, 'bcai-sync/conversations.json');
        const parsed = JSON.parse(Buffer.from(obj.bytes).toString('utf-8')) as { conversations?: any[]; syncedAt?: string };
        res.json({ ok: true, source: 'bucket', conversations: parsed.conversations || [], syncedAt: parsed.syncedAt });
        return;
      } catch (err: any) {
        if (source === 'bucket') {
          res.status(404).json({ error: `从存储桶拉取失败: ${err?.message}` });
          return;
        }
      }
    }

    if (dbCfg) {
      try {
        const conversations = await fetchExternalDbConversations(dbCfg);
        res.json({ ok: true, source: dbCfg.provider, conversations, syncedAt: new Date().toISOString() });
        return;
      } catch (err: any) {
        res.status(500).json({ error: `从数据库拉取失败: ${err?.message}` });
        return;
      }
    }

    res.status(400).json({ error: '尚未绑定远程数据库或对象存储桶' });
  });

  // ==========================================
  // Multi-Git Provider OAuth & Repo APIs (GitHub, GitLab, Gitee) — Admin Only
  // ==========================================
  app.get('/api/git/oauth-config', requireAdmin, (_req, res) => {
    const saved = readJsonFile<GitOAuthConfigStore>(GIT_OAUTH_CFG_FILE, {});
    const gh = getGitOAuthCredentials('github');
    const gl = getGitOAuthCredentials('gitlab');
    const ge = getGitOAuthCredentials('gitee');
    res.json({
      siteId: saved.siteId || '',
      github: { clientId: gh.clientId, configured: Boolean(gh.clientId && gh.clientSecret) },
      gitlab: { clientId: gl.clientId, hostUrl: gl.hostUrl, configured: Boolean(gl.clientId && gl.clientSecret) },
      gitee: { clientId: ge.clientId, configured: Boolean(ge.clientId && ge.clientSecret) },
    });
  });

  app.post('/api/git/oauth-config', requireAdmin, (req, res) => {
    const body = req.body as {
      siteId?: string;
      provider?: 'github' | 'gitlab' | 'gitee';
      clientId?: string;
      clientSecret?: string;
      hostUrl?: string;
    };
    const saved = readJsonFile<GitOAuthConfigStore>(GIT_OAUTH_CFG_FILE, {});
    if (typeof body.siteId === 'string') {
      saved.siteId = body.siteId.trim();
    }
    if (body.provider) {
      const prev = saved[body.provider] || {};
      saved[body.provider] = {
        clientId: typeof body.clientId === 'string' ? body.clientId.trim() : prev.clientId,
        clientSecret: body.clientSecret && body.clientSecret.trim() ? body.clientSecret.trim() : prev.clientSecret,
        ...(body.provider === 'gitlab' && body.hostUrl ? { hostUrl: body.hostUrl.trim().replace(/\/+$/, '') } : {}),
      };
    }
    writeJsonFile(GIT_OAUTH_CFG_FILE, saved);
    const creds = body.provider ? getGitOAuthCredentials(body.provider, body.hostUrl) : null;
    res.json({
      ok: true,
      siteId: saved.siteId || '',
      configured: creds ? Boolean(creds.clientId && creds.clientSecret) : undefined,
      message: '已保存仓库站点 OAuth 应用与站点 ID 配置',
    });
  });

  const buildGitOAuthUrl = (req: Request, provider: 'github' | 'gitlab' | 'gitee', hostUrlParam?: string) => {
    const creds = getGitOAuthCredentials(provider, hostUrlParam);
    if (!creds.clientId || !creds.clientSecret) {
      return {
        error: `未配置 ${provider.toUpperCase()} OAuth Client ID / Client Secret。可在环境变量或当前页面“连接仓库站点（OAuth 授权）”区填写保存后再发起授权。`,
      };
    }
    const store = getAdminStore();
    const redirectUri = `${getAppUrl(req)}/auth/callback`;
    const state = signOAuthState(
      {
        provider,
        hostUrl: creds.hostUrl,
        nonce: crypto.randomBytes(8).toString('hex'),
        ts: Date.now(),
      },
      store.sessionSecret
    );

    if (provider === 'github') {
      const params = new URLSearchParams({
        client_id: creds.clientId,
        redirect_uri: redirectUri,
        scope: 'repo read:user',
        state,
      });
      return { url: `https://github.com/login/oauth/authorize?${params.toString()}`, redirectUri };
    }

    if (provider === 'gitlab') {
      const params = new URLSearchParams({
        client_id: creds.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'api read_user write_repository',
        state,
      });
      return { url: `${creds.hostUrl}/oauth/authorize?${params.toString()}`, redirectUri };
    }

    // Gitee OAuth
    const params = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'user_info projects',
      state,
    });
    return { url: `https://gitee.com/oauth/authorize?${params.toString()}`, redirectUri };
  };

  app.get('/api/auth/git/url', requireAdmin, (req, res) => {
    const provider = ((req.query.provider as string) || 'github') as 'github' | 'gitlab' | 'gitee';
    const hostUrl = (req.query.hostUrl as string) || undefined;
    const built = buildGitOAuthUrl(req, provider, hostUrl);
    if (built.error) {
      res.status(400).json({ error: built.error });
      return;
    }
    res.json(built);
  });

  app.get('/api/auth/github/url', requireAdmin, (req, res) => {
    const built = buildGitOAuthUrl(req, 'github');
    if (built.error) {
      res.status(400).json({ error: built.error });
      return;
    }
    res.json(built);
  });

  const handleGitOAuthCallback = async (req: Request, res: Response) => {
    const code = req.query.code as string | undefined;
    const stateParam = (req.query.state as string) || '';
    const store = getAdminStore();
    const stateData = stateParam ? verifyOAuthState(stateParam, store.sessionSecret) : { provider: 'github', hostUrl: 'https://github.com' };

    if (!code || !stateData) {
      res.status(400).send('OAuth 回调缺少有效授权码 code 或 state 校验失败');
      return;
    }

    const provider = (stateData.provider || 'github') as 'github' | 'gitlab' | 'gitee';
    const creds = getGitOAuthCredentials(provider, stateData.hostUrl);
    if (!creds.clientId || !creds.clientSecret) {
      res.status(400).send(`缺少 ${provider.toUpperCase()} Client ID / Client Secret`);
      return;
    }

    const redirectUri = `${getAppUrl(req)}/auth/callback`;
    try {
      let accessToken = '';
      let user: any = null;

      if (provider === 'github') {
        const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({
            client_id: creds.clientId,
            client_secret: creds.clientSecret,
            code,
            redirect_uri: redirectUri,
          }),
        });
        const tokenJson = (await tokenRes.json()) as { access_token?: string; error_description?: string; error?: string };
        if (!tokenJson.access_token) {
          res.status(400).send(`GitHub 授权失败: ${tokenJson.error_description || tokenJson.error || '未知错误'}`);
          return;
        }
        accessToken = tokenJson.access_token;
        const userRes = await fetch('https://api.github.com/user', {
          headers: { authorization: `Bearer ${accessToken}`, 'user-agent': 'bcai-workbench' },
        });
        user = await userRes.json();
        setIframeCookie(res, 'aimx_gh_token', accessToken);
      } else if (provider === 'gitlab') {
        const tokenRes = await fetch(`${creds.hostUrl}/oauth/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: new URLSearchParams({
            client_id: creds.clientId,
            client_secret: creds.clientSecret,
            code,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri,
          }).toString(),
        });
        const tokenJson = (await tokenRes.json()) as { access_token?: string; error_description?: string; error?: string };
        if (!tokenJson.access_token) {
          res.status(400).send(`GitLab 授权失败: ${tokenJson.error_description || tokenJson.error || '未知错误'}`);
          return;
        }
        accessToken = tokenJson.access_token;
        const userRes = await fetch(`${creds.hostUrl}/api/v4/user`, {
          headers: { authorization: `Bearer ${accessToken}` },
        });
        const glUser = (await userRes.json()) as { username?: string; name?: string; avatar_url?: string; web_url?: string };
        user = {
          login: glUser.username || glUser.name || 'gitlab-user',
          name: glUser.name,
          avatar_url: glUser.avatar_url,
          html_url: glUser.web_url,
          provider: 'gitlab',
        };
      } else {
        const tokenRes = await fetch('https://gitee.com/oauth/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            client_id: creds.clientId,
            client_secret: creds.clientSecret,
            redirect_uri: redirectUri,
          }).toString(),
        });
        const tokenJson = (await tokenRes.json()) as { access_token?: string; error_description?: string; error?: string };
        if (!tokenJson.access_token) {
          res.status(400).send(`Gitee 授权失败: ${tokenJson.error_description || tokenJson.error || '未知错误'}`);
          return;
        }
        accessToken = tokenJson.access_token;
        const userRes = await fetch(`https://gitee.com/api/v5/user?access_token=${encodeURIComponent(accessToken)}`);
        const geUser = (await userRes.json()) as { login?: string; name?: string; avatar_url?: string; html_url?: string };
        user = {
          login: geUser.login || geUser.name || 'gitee-user',
          name: geUser.name,
          avatar_url: geUser.avatar_url,
          html_url: geUser.html_url,
          provider: 'gitee',
        };
      }

      const savedMap = readJsonFile<Record<string, string>>(GIT_CFG_FILE, {});
      savedMap[provider] = accessToken;
      writeJsonFile(GIT_CFG_FILE, savedMap);

      res.send(`<!doctype html>
        <html lang="zh-CN">
          <head><meta charset="utf-8"><title>${provider.toUpperCase()} OAuth 授权完成</title></head>
          <body style="font-family:system-ui,sans-serif;padding:24px;text-align:center;">
            <script>
              if (window.opener) {
                window.opener.postMessage({
                  type: 'OAUTH_AUTH_SUCCESS',
                  provider: ${JSON.stringify(provider)},
                  hostUrl: ${JSON.stringify(creds.hostUrl)},
                  user: ${JSON.stringify(user)},
                  token: ${JSON.stringify(accessToken)}
                }, '*');
                window.close();
              } else {
                window.location.href = '/';
              }
            </script>
            <p>${provider.toUpperCase()} OAuth 授权成功，正在返回 BCAI 工作台...</p>
          </body>
        </html>`);
    } catch (err: any) {
      res.status(500).send(`OAuth 处理失败: ${err?.message}`);
    }
  };

  app.get(['/auth/callback', '/auth/callback/'], handleGitOAuthCallback);

  app.post('/api/git/connect', requireAdmin, async (req, res) => {
    const {
      provider = 'github',
      token,
      hostUrl,
    } = req.body as {
      provider?: 'github' | 'gitlab' | 'gitee';
      token?: string;
      hostUrl?: string;
    };
    if (!token || !token.trim()) {
      res.status(400).json({ error: '请输入平台 Access Token' });
      return;
    }
    const cleanToken = token.trim();
    try {
      let user: any = null;
      if (provider === 'github') {
        const r = await fetch('https://api.github.com/user', {
          headers: { authorization: `Bearer ${cleanToken}`, 'user-agent': 'bcai-workbench' },
        });
        if (!r.ok) throw new Error(`GitHub 验证失败 (HTTP ${r.status})`);
        user = await r.json();
        setIframeCookie(res, 'aimx_gh_token', cleanToken);
      } else if (provider === 'gitlab') {
        const base = (hostUrl || 'https://gitlab.com').replace(/\/+$/, '');
        const r = await fetch(`${base}/api/v4/user`, {
          headers: { 'PRIVATE-TOKEN': cleanToken },
        });
        if (!r.ok) throw new Error(`GitLab 验证失败 (HTTP ${r.status})`);
        const glUser = (await r.json()) as { username?: string; name?: string; avatar_url?: string; web_url?: string };
        user = {
          login: glUser.username || glUser.name || 'gitlab-user',
          name: glUser.name,
          avatar_url: glUser.avatar_url,
          html_url: glUser.web_url,
          provider: 'gitlab',
        };
      } else {
        const r = await fetch(`https://gitee.com/api/v5/user?access_token=${encodeURIComponent(cleanToken)}`);
        if (!r.ok) throw new Error(`Gitee 验证失败 (HTTP ${r.status})`);
        const geUser = (await r.json()) as { login?: string; name?: string; avatar_url?: string; html_url?: string };
        user = {
          login: geUser.login || geUser.name || 'gitee-user',
          name: geUser.name,
          avatar_url: geUser.avatar_url,
          html_url: geUser.html_url,
          provider: 'gitee',
        };
      }

      const savedMap = readJsonFile<Record<string, string>>(GIT_CFG_FILE, {});
      savedMap[provider] = cleanToken;
      writeJsonFile(GIT_CFG_FILE, savedMap);

      res.json({ ok: true, provider, user });
    } catch (err: any) {
      res.status(401).json({ error: err?.message || 'Git 凭证验证失败' });
    }
  });

  app.post('/api/git/disconnect', requireAdmin, (req, res) => {
    const { provider = 'github' } = req.body as { provider?: 'github' | 'gitlab' | 'gitee' };
    const savedMap = readJsonFile<Record<string, string>>(GIT_CFG_FILE, {});
    delete savedMap[provider];
    writeJsonFile(GIT_CFG_FILE, savedMap);
    if (provider === 'github') {
      clearIframeCookie(res, 'aimx_gh_token');
    }
    res.json({ ok: true });
  });

  app.get('/api/git/status', requireAdmin, async (req, res) => {
    const provider = ((req.query.provider as string) || 'github') as 'github' | 'gitlab' | 'gitee';
    const hostUrl = (req.query.hostUrl as string) || 'https://gitlab.com';
    const token = getGitToken(req, provider);
    if (!token) {
      res.json({ connected: false, provider });
      return;
    }
    try {
      if (provider === 'github') {
        const r = await fetch('https://api.github.com/user', {
          headers: { authorization: `Bearer ${token}`, 'user-agent': 'bcai-workbench' },
        });
        if (!r.ok) {
          res.json({ connected: false, provider });
          return;
        }
        res.json({ connected: true, provider, user: await r.json() });
        return;
      }
      if (provider === 'gitlab') {
        const base = hostUrl.replace(/\/+$/, '');
        const r = await fetch(`${base}/api/v4/user`, { headers: { 'PRIVATE-TOKEN': token } });
        if (!r.ok) {
          res.json({ connected: false, provider });
          return;
        }
        const gl = (await r.json()) as any;
        res.json({ connected: true, provider, user: { login: gl.username, name: gl.name, avatar_url: gl.avatar_url, provider: 'gitlab' } });
        return;
      }
      const r = await fetch(`https://gitee.com/api/v5/user?access_token=${encodeURIComponent(token)}`);
      if (!r.ok) {
        res.json({ connected: false, provider });
        return;
      }
      const ge = (await r.json()) as any;
      res.json({ connected: true, provider, user: { login: ge.login, name: ge.name, avatar_url: ge.avatar_url, provider: 'gitee' } });
    } catch {
      res.json({ connected: false, provider });
    }
  });

  app.get('/api/git/repos', requireAdmin, async (req, res) => {
    const provider = ((req.query.provider as string) || 'github') as 'github' | 'gitlab' | 'gitee';
    const hostUrl = (req.query.hostUrl as string) || 'https://gitlab.com';
    const token = getGitToken(req, provider);
    if (!token) {
      res.status(401).json({ error: `未连接 ${provider} 账号` });
      return;
    }
    try {
      if (provider === 'github') {
        const r = await fetch('https://api.github.com/user/repos?sort=updated&per_page=50&affiliation=owner,collaborator,organization_member', {
          headers: { authorization: `Bearer ${token}`, 'user-agent': 'bcai-workbench' },
        });
        const data = await r.json();
        res.status(r.status).json({ repos: Array.isArray(data) ? data : [] });
        return;
      }
      if (provider === 'gitlab') {
        const base = hostUrl.replace(/\/+$/, '');
        const r = await fetch(`${base}/api/v4/projects?membership=true&per_page=50&order_by=updated_at`, {
          headers: { 'PRIVATE-TOKEN': token },
        });
        const data = (await r.json()) as any[];
        const mapped = Array.isArray(data)
          ? data.map((p) => ({
              id: p.id,
              full_name: p.path_with_namespace,
              name: p.name,
              default_branch: p.default_branch || 'main',
              private: p.visibility !== 'public',
              description: p.description,
              html_url: p.web_url,
            }))
          : [];
        res.status(r.status).json({ repos: mapped });
        return;
      }
      const r = await fetch(`https://gitee.com/api/v5/user/repos?access_token=${encodeURIComponent(token)}&sort=updated&per_page=50`);
      const data = (await r.json()) as any[];
      const mapped = Array.isArray(data)
        ? data.map((p) => ({
            id: p.id,
            full_name: p.full_name,
            name: p.name,
            default_branch: p.default_branch || 'master',
            private: Boolean(p.private),
            description: p.description,
            html_url: p.html_url,
          }))
        : [];
      res.status(r.status).json({ repos: mapped });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  app.get('/api/git/branches', requireAdmin, async (req, res) => {
    const provider = ((req.query.provider as string) || 'github') as 'github' | 'gitlab' | 'gitee';
    const hostUrl = (req.query.hostUrl as string) || 'https://gitlab.com';
    const repo = parseRepoSlug((req.query.repo as string) || '');
    const token = getGitToken(req, provider);
    try {
      if (provider === 'github') {
        const headers: Record<string, string> = { 'user-agent': 'bcai-workbench' };
        if (token) headers.authorization = `Bearer ${token}`;
        const r = await fetch(`https://api.github.com/repos/${repo}/branches?per_page=100`, { headers });
        const data = await r.json();
        res.status(r.status).json({ branches: Array.isArray(data) ? data : [] });
        return;
      }
      if (provider === 'gitlab') {
        const base = hostUrl.replace(/\/+$/, '');
        const headers: Record<string, string> = {};
        if (token) headers['PRIVATE-TOKEN'] = token;
        const r = await fetch(`${base}/api/v4/projects/${encodeURIComponent(repo)}/repository/branches?per_page=100`, { headers });
        const data = await r.json();
        res.status(r.status).json({ branches: Array.isArray(data) ? data : [] });
        return;
      }
      const q = token ? `?access_token=${encodeURIComponent(token)}` : '';
      const r = await fetch(`https://gitee.com/api/v5/repos/${repo}/branches${q}`);
      const data = await r.json();
      res.status(r.status).json({ branches: Array.isArray(data) ? data : [] });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  app.get('/api/git/tree', requireAdmin, async (req, res) => {
    const provider = ((req.query.provider as string) || 'github') as 'github' | 'gitlab' | 'gitee';
    const hostUrl = (req.query.hostUrl as string) || 'https://gitlab.com';
    const repo = parseRepoSlug((req.query.repo as string) || '');
    const branch = (req.query.branch as string) || 'main';
    const token = getGitToken(req, provider);
    try {
      if (provider === 'github') {
        const headers: Record<string, string> = { 'user-agent': 'bcai-workbench' };
        if (token) headers.authorization = `Bearer ${token}`;
        const r = await fetch(`https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, { headers });
        const data = (await r.json()) as { tree?: any[]; message?: string };
        if (!r.ok) {
          res.status(r.status).json({ error: data?.message || '读取目录树失败' });
          return;
        }
        res.json({ tree: data.tree || [] });
        return;
      }
      if (provider === 'gitlab') {
        const base = hostUrl.replace(/\/+$/, '');
        const headers: Record<string, string> = {};
        if (token) headers['PRIVATE-TOKEN'] = token;
        const r = await fetch(
          `${base}/api/v4/projects/${encodeURIComponent(repo)}/repository/tree?ref=${encodeURIComponent(branch)}&recursive=true&per_page=100`,
          { headers }
        );
        const data = (await r.json()) as any[];
        if (!r.ok) {
          res.status(r.status).json({ error: (data as any)?.message || '读取 GitLab 目录失败' });
          return;
        }
        res.json({
          tree: Array.isArray(data)
            ? data.map((i) => ({ path: i.path, type: i.type === 'tree' ? 'tree' : 'blob', sha: i.id }))
            : [],
        });
        return;
      }
      const q = token ? `?access_token=${encodeURIComponent(token)}&recursive=1` : '?recursive=1';
      const r = await fetch(`https://gitee.com/api/v5/repos/${repo}/git/trees/${encodeURIComponent(branch)}${q}`);
      const data = (await r.json()) as { tree?: any[]; message?: string };
      if (!r.ok) {
        res.status(r.status).json({ error: data?.message || '读取 Gitee 目录失败' });
        return;
      }
      res.json({ tree: data.tree || [] });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  app.get('/api/git/file', requireAdmin, async (req, res) => {
    const provider = ((req.query.provider as string) || 'github') as 'github' | 'gitlab' | 'gitee';
    const hostUrl = (req.query.hostUrl as string) || 'https://gitlab.com';
    const repo = parseRepoSlug((req.query.repo as string) || '');
    const filePath = (req.query.path as string) || '';
    const branch = (req.query.branch as string) || 'main';
    const token = getGitToken(req, provider);
    if (!repo || !filePath) {
      res.status(400).json({ error: '缺少 repo 或 path 参数' });
      return;
    }
    try {
      if (provider === 'github') {
        const headers: Record<string, string> = { 'user-agent': 'bcai-workbench' };
        if (token) headers.authorization = `Bearer ${token}`;
        const r = await fetch(
          `https://api.github.com/repos/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`,
          { headers }
        );
        const data = (await r.json()) as { content?: string; sha?: string; size?: number; message?: string };
        if (!r.ok) {
          res.status(r.status).json({ error: data?.message || '读取文件失败' });
          return;
        }
        const decoded = data.content ? Buffer.from(data.content, 'base64').toString('utf-8') : '';
        res.json({ path: filePath, sha: data.sha, size: data.size, content: decoded });
        return;
      }
      if (provider === 'gitlab') {
        const base = hostUrl.replace(/\/+$/, '');
        const headers: Record<string, string> = {};
        if (token) headers['PRIVATE-TOKEN'] = token;
        const r = await fetch(
          `${base}/api/v4/projects/${encodeURIComponent(repo)}/repository/files/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(branch)}`,
          { headers }
        );
        const data = (await r.json()) as { content?: string; blob_id?: string; size?: number; message?: string };
        if (!r.ok) {
          res.status(r.status).json({ error: data?.message || '读取 GitLab 文件失败' });
          return;
        }
        const decoded = data.content ? Buffer.from(data.content, 'base64').toString('utf-8') : '';
        res.json({ path: filePath, sha: data.blob_id, size: data.size, content: decoded });
        return;
      }
      const q = `ref=${encodeURIComponent(branch)}${token ? `&access_token=${encodeURIComponent(token)}` : ''}`;
      const r = await fetch(
        `https://gitee.com/api/v5/repos/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?${q}`
      );
      const data = (await r.json()) as { content?: string; sha?: string; size?: number; message?: string };
      if (!r.ok) {
        res.status(r.status).json({ error: data?.message || '读取 Gitee 文件失败' });
        return;
      }
      const decoded = data.content ? Buffer.from(data.content, 'base64').toString('utf-8') : '';
      res.json({ path: filePath, sha: data.sha, size: data.size, content: decoded });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  app.post('/api/git/branch', requireAdmin, async (req, res) => {
    const { provider = 'github', hostUrl = 'https://gitlab.com', repo: rawRepo, newBranch, fromBranch = 'main' } = req.body as {
      provider?: 'github' | 'gitlab' | 'gitee';
      hostUrl?: string;
      repo: string;
      newBranch: string;
      fromBranch?: string;
    };
    const repo = parseRepoSlug(rawRepo);
    const token = getGitToken(req, provider);
    if (!token) {
      res.status(401).json({ error: `创建分支需要先连接 ${provider} Token` });
      return;
    }
    try {
      if (provider === 'github') {
        const refRes = await fetch(`https://api.github.com/repos/${repo}/git/ref/heads/${encodeURIComponent(fromBranch)}`, {
          headers: { authorization: `Bearer ${token}`, 'user-agent': 'bcai-workbench' },
        });
        const refData = (await refRes.json()) as { object?: { sha: string }; message?: string };
        if (!refRes.ok || !refData?.object?.sha) {
          res.status(refRes.status).json({ error: refData?.message || '获取源分支 SHA 失败' });
          return;
        }
        const createRes = await fetch(`https://api.github.com/repos/${repo}/git/refs`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'user-agent': 'bcai-workbench', 'content-type': 'application/json' },
          body: JSON.stringify({ ref: `refs/heads/${newBranch}`, sha: refData.object.sha }),
        });
        const createData = await createRes.json();
        if (!createRes.ok) {
          res.status(createRes.status).json({ error: (createData as any)?.message || '创建分支失败' });
          return;
        }
        res.json({ ok: true, branch: newBranch });
        return;
      }
      if (provider === 'gitlab') {
        const base = hostUrl.replace(/\/+$/, '');
        const r = await fetch(`${base}/api/v4/projects/${encodeURIComponent(repo)}/repository/branches`, {
          method: 'POST',
          headers: { 'PRIVATE-TOKEN': token, 'content-type': 'application/json' },
          body: JSON.stringify({ branch: newBranch, ref: fromBranch }),
        });
        const d = await r.json();
        if (!r.ok) {
          res.status(r.status).json({ error: (d as any)?.message || '创建 GitLab 分支失败' });
          return;
        }
        res.json({ ok: true, branch: newBranch });
        return;
      }
      const r = await fetch(`https://gitee.com/api/v5/repos/${repo}/branches`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ access_token: token, refs: fromBranch, branch_name: newBranch }),
      });
      const d = await r.json();
      if (!r.ok) {
        res.status(r.status).json({ error: (d as any)?.message || '创建 Gitee 分支失败' });
        return;
      }
      res.json({ ok: true, branch: newBranch });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  app.put('/api/git/file', requireAdmin, async (req, res) => {
    const {
      provider = 'github',
      hostUrl = 'https://gitlab.com',
      repo: rawRepo,
      path: filePath,
      content,
      message,
      branch = 'main',
      sha,
    } = req.body as {
      provider?: 'github' | 'gitlab' | 'gitee';
      hostUrl?: string;
      repo: string;
      path: string;
      content: string;
      message?: string;
      branch?: string;
      sha?: string;
    };
    const repo = parseRepoSlug(rawRepo);
    const token = getGitToken(req, provider);
    if (!token) {
      res.status(401).json({ error: `写入推送文件需要先连接 ${provider}` });
      return;
    }
    try {
      if (provider === 'github') {
        let currentSha = sha;
        if (!currentSha) {
          const check = await fetch(
            `https://api.github.com/repos/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`,
            { headers: { authorization: `Bearer ${token}`, 'user-agent': 'bcai-workbench' } }
          );
          if (check.ok) {
            const existing = (await check.json()) as { sha?: string };
            currentSha = existing.sha;
          }
        }
        const r = await fetch(
          `https://api.github.com/repos/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}`,
          {
            method: 'PUT',
            headers: {
              authorization: `Bearer ${token}`,
              'user-agent': 'bcai-workbench',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              message: message || `Update ${filePath} via BCAI Workbench`,
              content: Buffer.from(content, 'utf-8').toString('base64'),
              branch,
              ...(currentSha ? { sha: currentSha } : {}),
            }),
          }
        );
        const data = await r.json();
        if (!r.ok) {
          res.status(r.status).json({ error: (data as any)?.message || '推送提交失败' });
          return;
        }
        res.json({ ok: true, commit: (data as any)?.commit, content: (data as any)?.content });
        return;
      }

      if (provider === 'gitlab') {
        const base = hostUrl.replace(/\/+$/, '');
        const check = await fetch(
          `${base}/api/v4/projects/${encodeURIComponent(repo)}/repository/files/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(branch)}`,
          { headers: { 'PRIVATE-TOKEN': token } }
        );
        const method = check.ok ? 'PUT' : 'POST';
        const r = await fetch(
          `${base}/api/v4/projects/${encodeURIComponent(repo)}/repository/files/${encodeURIComponent(filePath)}`,
          {
            method,
            headers: { 'PRIVATE-TOKEN': token, 'content-type': 'application/json' },
            body: JSON.stringify({
              branch,
              content,
              commit_message: message || `Update ${filePath} via BCAI Workbench`,
            }),
          }
        );
        const data = await r.json();
        if (!r.ok) {
          res.status(r.status).json({ error: (data as any)?.message || 'GitLab 提交失败' });
          return;
        }
        res.json({ ok: true, content: data });
        return;
      }

      // Gitee
      let currentSha = sha;
      if (!currentSha) {
        const check = await fetch(
          `https://gitee.com/api/v5/repos/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}&access_token=${encodeURIComponent(token)}`
        );
        if (check.ok) {
          const existing = (await check.json()) as { sha?: string };
          currentSha = existing.sha;
        }
      }
      const r = await fetch(
        `https://gitee.com/api/v5/repos/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}`,
        {
          method: currentSha ? 'PUT' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            access_token: token,
            content: Buffer.from(content, 'utf-8').toString('base64'),
            message: message || `Update ${filePath} via BCAI Workbench`,
            branch,
            ...(currentSha ? { sha: currentSha } : {}),
          }),
        }
      );
      const data = await r.json();
      if (!r.ok) {
        res.status(r.status).json({ error: (data as any)?.message || 'Gitee 提交失败' });
        return;
      }
      res.json({ ok: true, commit: (data as any)?.commit, content: (data as any)?.content });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // Sync full project files to GitHub / GitLab / Gitee
  app.post('/api/git/sync-project', requireAdmin, async (req, res) => {
    const {
      provider = 'github',
      hostUrl = 'https://gitlab.com',
      repo: rawRepo = '757926525/bcai',
      branch = 'main',
      commitMessage = 'feat: BCAI AI Workbench full-stack update',
    } = req.body as {
      provider?: 'github' | 'gitlab' | 'gitee';
      hostUrl?: string;
      repo?: string;
      branch?: string;
      commitMessage?: string;
      token?: string;
    };
    const repo = parseRepoSlug(rawRepo);
    const token = getGitToken(req, provider);
    if (!token) {
      res.status(401).json({
        error: `缺少 ${provider} 推送凭证：请先输入 Access Token 或通过授权连接后再重试推送。`,
      });
      return;
    }

    const collectFiles = (dir: string, base = ''): Array<{ relPath: string; content: string }> => {
      const out: Array<{ relPath: string; content: string }> = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', 'dist', '.git', '.data', 'aistudio'].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        const rel = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          out.push(...collectFiles(full, rel));
        } else if (
          entry.isFile() &&
          (/\.(ts|tsx|js|json|html|css|md|sql|toml|yml|yaml|example)$/.test(entry.name) ||
            entry.name === 'Dockerfile' ||
            entry.name === '.gitignore')
        ) {
          out.push({ relPath: rel, content: fs.readFileSync(full, 'utf-8') });
        }
      }
      return out;
    };

    try {
      const files = collectFiles(__dirname);
      if (files.length === 0) {
        res.status(400).json({ error: '未收集到可推送的项目源码文件' });
        return;
      }

      if (provider === 'gitlab') {
        const base = hostUrl.replace(/\/+$/, '');
        // Check existing files to decide create vs update action
        const treeRes = await fetch(
          `${base}/api/v4/projects/${encodeURIComponent(repo)}/repository/tree?ref=${encodeURIComponent(branch)}&recursive=true&per_page=100`,
          { headers: { 'PRIVATE-TOKEN': token } }
        );
        const existingList = treeRes.ok ? ((await treeRes.json()) as Array<{ path: string }>) : [];
        const existingSet = new Set(Array.isArray(existingList) ? existingList.map((i) => i.path) : []);
        const actions = files.map((f) => ({
          action: existingSet.has(f.relPath) ? 'update' : 'create',
          file_path: f.relPath,
          content: f.content,
        }));
        const commitRes = await fetch(`${base}/api/v4/projects/${encodeURIComponent(repo)}/repository/commits`, {
          method: 'POST',
          headers: { 'PRIVATE-TOKEN': token, 'content-type': 'application/json' },
          body: JSON.stringify({
            branch,
            commit_message: commitMessage,
            actions,
          }),
        });
        const commitData = (await commitRes.json()) as { id?: string; web_url?: string; message?: string };
        if (!commitRes.ok) {
          res.status(commitRes.status).json({ error: commitData?.message || 'GitLab 批量提交失败' });
          return;
        }
        res.json({
          ok: true,
          pushedCount: files.length,
          total: files.length,
          commitSha: commitData.id,
          commitUrl: commitData.web_url,
        });
        return;
      }

      if (provider === 'gitee') {
        let pushed = 0;
        const errors: string[] = [];
        for (const f of files) {
          const check = await fetch(
            `https://gitee.com/api/v5/repos/${repo}/contents/${f.relPath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}&access_token=${encodeURIComponent(token)}`
          );
          const existing = check.ok ? ((await check.json()) as { sha?: string }) : {};
          const r = await fetch(
            `https://gitee.com/api/v5/repos/${repo}/contents/${f.relPath.split('/').map(encodeURIComponent).join('/')}`,
            {
              method: existing?.sha ? 'PUT' : 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                access_token: token,
                content: Buffer.from(f.content, 'utf-8').toString('base64'),
                message: commitMessage,
                branch,
                ...(existing?.sha ? { sha: existing.sha } : {}),
              }),
            }
          );
          if (r.ok) pushed++;
          else errors.push(`${f.relPath}: HTTP ${r.status}`);
        }
        res.json({ ok: pushed > 0, pushedCount: pushed, total: files.length, errors });
        return;
      }

      // GitHub atomic single commit via Git Trees API
      const ghFetch = async (urlPath: string, init: RequestInit = {}) => {
        const r = await fetch(`https://api.github.com${urlPath}`, {
          ...init,
          headers: {
            authorization: `Bearer ${token}`,
            'user-agent': 'bcai-workbench',
            accept: 'application/vnd.github+json',
            'content-type': 'application/json',
            ...(init.headers || {}),
          },
        });
        const json = (await r.json().catch(() => ({}))) as any;
        return { ok: r.ok, status: r.status, json };
      };

      let refRes = await ghFetch(`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
      if (!refRes.ok) {
        const readmeFile = files.find((f) => f.relPath === 'README.md') || files[0];
        const initRes = await ghFetch(
          `/repos/${repo}/contents/${readmeFile.relPath.split('/').map(encodeURIComponent).join('/')}`,
          {
            method: 'PUT',
            body: JSON.stringify({
              message: 'chore: initialize BCAI repository',
              content: Buffer.from(readmeFile.content, 'utf-8').toString('base64'),
              branch,
            }),
          }
        );
        if (!initRes.ok) {
          res.status(initRes.status).json({
            error: `初始化仓库失败 (${initRes.status}): ${initRes.json?.message || '请确认 Token 具备 repo 写入权限'}`,
          });
          return;
        }
        refRes = await ghFetch(`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
      }

      if (!refRes.ok || !refRes.json?.object?.sha) {
        res.status(refRes.status || 400).json({
          error: `无法定位分支 ${branch}: ${refRes.json?.message || '请检查仓库权限'}`,
        });
        return;
      }

      const parentCommitSha: string = refRes.json.object.sha;
      const commitInfo = await ghFetch(`/repos/${repo}/git/commits/${parentCommitSha}`);
      const baseTreeSha: string | undefined = commitInfo.json?.tree?.sha;

      const treeEntries: Array<{ path: string; mode: string; type: string; sha: string }> = [];
      const errors: string[] = [];

      for (let i = 0; i < files.length; i += 6) {
        const batch = files.slice(i, i + 6);
        const results = await Promise.all(
          batch.map(async (f) => {
            const blobRes = await ghFetch(`/repos/${repo}/git/blobs`, {
              method: 'POST',
              body: JSON.stringify({
                content: Buffer.from(f.content, 'utf-8').toString('base64'),
                encoding: 'base64',
              }),
            });
            return { f, blobRes };
          })
        );
        for (const { f, blobRes } of results) {
          if (blobRes.ok && blobRes.json?.sha) {
            treeEntries.push({
              path: f.relPath,
              mode: '100644',
              type: 'blob',
              sha: blobRes.json.sha,
            });
          } else {
            errors.push(`${f.relPath}: ${blobRes.json?.message || blobRes.status}`);
          }
        }
      }

      if (treeEntries.length === 0) {
        res.status(500).json({ error: `创建 Git Blobs 失败: ${errors[0] || '未知错误'}` });
        return;
      }

      const treeRes = await ghFetch(`/repos/${repo}/git/trees`, {
        method: 'POST',
        body: JSON.stringify({
          ...(baseTreeSha ? { base_tree: baseTreeSha } : {}),
          tree: treeEntries,
        }),
      });
      if (!treeRes.ok || !treeRes.json?.sha) {
        res.status(treeRes.status).json({ error: `创建 Git Tree 失败: ${treeRes.json?.message}` });
        return;
      }

      const newCommitRes = await ghFetch(`/repos/${repo}/git/commits`, {
        method: 'POST',
        body: JSON.stringify({
          message: commitMessage,
          tree: treeRes.json.sha,
          parents: [parentCommitSha],
        }),
      });
      if (!newCommitRes.ok || !newCommitRes.json?.sha) {
        res.status(newCommitRes.status).json({ error: `创建 Git Commit 失败: ${newCommitRes.json?.message}` });
        return;
      }

      const updateRefRes = await ghFetch(`/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          sha: newCommitRes.json.sha,
          force: false,
        }),
      });
      if (!updateRefRes.ok) {
        res.status(updateRefRes.status).json({ error: `更新分支 ${branch} 失败: ${updateRefRes.json?.message}` });
        return;
      }

      res.json({
        ok: errors.length === 0,
        pushedCount: treeEntries.length,
        total: files.length,
        commitSha: newCommitRes.json.sha,
        commitUrl: `https://github.com/${repo}/commit/${newCommitRes.json.sha}`,
        errors,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || '同步项目失败' });
    }
  });

  // ==========================================
  // Universal Connectors Hub (Cloud Disks / Email / Deploy Platforms / Other) — Admin Only
  // ==========================================
  app.get('/api/connectors', requireAdmin, (_req, res) => {
    const items = readJsonFile<any[]>(CONNECTORS_FILE, []);
    res.json({ items });
  });

  app.post('/api/connectors', requireAdmin, (req, res) => {
    const item = req.body as Record<string, any>;
    if (!item?.name || !item?.category) {
      res.status(400).json({ error: '请填写连接器名称与分类' });
      return;
    }
    const items = readJsonFile<any[]>(CONNECTORS_FILE, []);
    const now = new Date().toISOString();
    const next = {
      ...item,
      id: item.id || `conn_${Date.now()}`,
      updatedAt: now,
    };
    const idx = items.findIndex((x) => x.id === next.id);
    if (idx >= 0) items[idx] = next;
    else items.unshift(next);
    writeJsonFile(CONNECTORS_FILE, items);
    res.json({ ok: true, item: next });
  });

  app.delete('/api/connectors/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    const items = readJsonFile<any[]>(CONNECTORS_FILE, []);
    writeJsonFile(
      CONNECTORS_FILE,
      items.filter((x) => x.id !== id)
    );
    res.json({ ok: true });
  });

  app.post('/api/connectors/probe', requireAdmin, async (req, res) => {
    const { presetKey, endpoint = '', usernameOrId = '', secretToken = '' } = req.body as {
      presetKey: string;
      endpoint?: string;
      usernameOrId?: string;
      secretToken?: string;
    };
    const start = Date.now();
    try {
      if (!endpoint && !secretToken) {
        res.json({ status: 'unconfigured', message: '未填写端点或认证令牌' });
        return;
      }

      if (presetKey === 'cloudflare') {
        const r = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
          headers: { authorization: `Bearer ${secretToken}` },
        });
        const j = (await r.json().catch(() => ({}))) as { success?: boolean; errors?: Array<{ message: string }> };
        res.json({
          status: r.ok && j.success ? 'connected' : 'error',
          latencyMs: Date.now() - start,
          message: r.ok && j.success ? 'Cloudflare Token 验证有效' : j?.errors?.[0]?.message || `HTTP ${r.status}`,
        });
        return;
      }

      if (presetKey === 'vercel') {
        const r = await fetch('https://api.vercel.com/v2/user', {
          headers: { authorization: `Bearer ${secretToken}` },
        });
        res.json({
          status: r.ok ? 'connected' : 'error',
          latencyMs: Date.now() - start,
          message: r.ok ? 'Vercel API 连通正常' : `Vercel HTTP ${r.status}`,
        });
        return;
      }

      if (presetKey === 'netlify') {
        const r = await fetch('https://api.netlify.com/api/v1/user', {
          headers: { authorization: `Bearer ${secretToken}` },
        });
        res.json({
          status: r.ok ? 'connected' : 'error',
          latencyMs: Date.now() - start,
          message: r.ok ? 'Netlify API 连通正常' : `Netlify HTTP ${r.status}`,
        });
        return;
      }

      if (presetKey === 'resend') {
        const r = await fetch('https://api.resend.com/domains', {
          headers: { authorization: `Bearer ${secretToken}` },
        });
        res.json({
          status: r.ok ? 'connected' : 'error',
          latencyMs: Date.now() - start,
          message: r.ok ? 'Resend 邮件 API 连通正常' : `Resend HTTP ${r.status}`,
        });
        return;
      }

      if (presetKey === 'webdav' || presetKey === 'alist') {
        assertSafeExternalUrl(endpoint);
        const headers: Record<string, string> = {};
        if (usernameOrId && secretToken) {
          headers.authorization = `Basic ${Buffer.from(`${usernameOrId}:${secretToken}`).toString('base64')}`;
        } else if (secretToken) {
          headers.authorization = `Bearer ${secretToken}`;
        }
        const target = presetKey === 'alist' ? `${endpoint.replace(/\/+$/, '')}/api/public/settings` : endpoint;
        const r = await fetch(target, {
          method: presetKey === 'webdav' ? 'OPTIONS' : 'GET',
          headers,
        });
        res.json({
          status: r.ok || r.status === 207 || r.status === 204 ? 'connected' : 'error',
          latencyMs: Date.now() - start,
          message: r.ok || r.status === 207 ? `网盘节点响应正常 (HTTP ${r.status})` : `HTTP ${r.status}`,
        });
        return;
      }

      const headers: Record<string, string> = {};
      if (secretToken) headers.authorization = `Bearer ${secretToken}`;
      const targetUrl =
        endpoint ||
        (presetKey === 'gdrive'
          ? 'https://www.googleapis.com/drive/v3/about?fields=user'
          : presetKey === 'onedrive'
          ? 'https://graph.microsoft.com/v1.0/me/drive'
          : '');
      if (!targetUrl) {
        res.json({ status: 'unconfigured', message: '请填写检测端点 URL' });
        return;
      }
      assertSafeExternalUrl(targetUrl);
      const r = await fetch(targetUrl, { method: 'GET', headers });
      res.json({
        status: r.ok ? 'connected' : 'error',
        latencyMs: Date.now() - start,
        message: r.ok ? `连接器探活正常 (HTTP ${r.status})` : `HTTP ${r.status}`,
      });
    } catch (err: any) {
      res.json({
        status: 'error',
        latencyMs: Date.now() - start,
        message: err?.message || '连接探测失败',
      });
    }
  });

  // Save AI-generated code directly from Chat to a connected Connector (WebDAV / Alist / OneDrive / Google Drive / Webhook)
  app.post('/api/connectors/save-code', requireAdmin, async (req, res) => {
    const {
      connectorId,
      filename = `bcai-snippet-${Date.now()}.txt`,
      targetDir = '',
      code = '',
      lang = 'text',
      conversationTitle = '',
    } = req.body as {
      connectorId: string;
      filename?: string;
      targetDir?: string;
      code: string;
      lang?: string;
      conversationTitle?: string;
    };

    if (!connectorId || !code) {
      res.status(400).json({ error: '缺少 connectorId 或代码内容' });
      return;
    }

    const items = readJsonFile<any[]>(CONNECTORS_FILE, []);
    const conn = items.find((c) => c.id === connectorId);
    if (!conn) {
      res.status(404).json({ error: '未找到对应的已连接连接器' });
      return;
    }

    const cleanFile = filename.replace(/[/\\:*?"<>|]/g, '_').replace(/^\.+/, '') || `snippet-${Date.now()}.txt`;
    const baseDir = (targetDir || conn.extraConfig || 'bcai-code')
      .split('/')
      .map((seg: string) => seg.trim())
      .filter((seg: string) => seg && seg !== '.' && seg !== '..')
      .join('/');
    const relPath = baseDir ? `${baseDir}/${cleanFile}` : cleanFile;

    try {
      if (conn.presetKey === 'webdav') {
        assertSafeExternalUrl(conn.endpoint);
        const putUrl = `${String(conn.endpoint).replace(/\/+$/, '')}/${relPath.split('/').map(encodeURIComponent).join('/')}`;
        const headers: Record<string, string> = { 'content-type': 'text/plain; charset=utf-8' };
        if (conn.usernameOrId && conn.secretToken) {
          headers.authorization = `Basic ${Buffer.from(`${conn.usernameOrId}:${conn.secretToken}`).toString('base64')}`;
        } else if (conn.secretToken) {
          headers.authorization = `Bearer ${conn.secretToken}`;
        }
        const r = await fetch(putUrl, { method: 'PUT', headers, body: code });
        if (!r.ok && r.status !== 201 && r.status !== 204) {
          throw new Error(`WebDAV 上传失败 (HTTP ${r.status})`);
        }
        res.json({ ok: true, connectorName: conn.name, targetPath: relPath, message: `已写入 WebDAV：/${relPath}` });
        return;
      }

      if (conn.presetKey === 'alist') {
        assertSafeExternalUrl(conn.endpoint);
        const putUrl = `${String(conn.endpoint).replace(/\/+$/, '')}/api/fs/put`;
        const headers: Record<string, string> = {
          'content-type': 'text/plain; charset=utf-8',
          'file-path': encodeURIComponent(`/${relPath}`),
        };
        if (conn.secretToken) headers.authorization = conn.secretToken;
        const r = await fetch(putUrl, { method: 'PUT', headers, body: code });
        const j = (await r.json().catch(() => ({}))) as { code?: number; message?: string };
        if (!r.ok || (typeof j.code === 'number' && j.code !== 200)) {
          throw new Error(j.message || `Alist 上传失败 (HTTP ${r.status})`);
        }
        res.json({ ok: true, connectorName: conn.name, targetPath: `/${relPath}`, message: `已存入 Alist 网盘：/${relPath}` });
        return;
      }

      if (conn.presetKey === 'onedrive') {
        if (!conn.secretToken) throw new Error('OneDrive 连接器缺少 OAuth Token');
        const putUrl = `https://graph.microsoft.com/v1.0/me/drive/root:/${relPath.split('/').map(encodeURIComponent).join('/')}:/content`;
        const r = await fetch(putUrl, {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${conn.secretToken}`,
            'content-type': 'text/plain; charset=utf-8',
          },
          body: code,
        });
        if (!r.ok) throw new Error(`OneDrive 上传失败 (HTTP ${r.status})`);
        res.json({ ok: true, connectorName: conn.name, targetPath: `/${relPath}`, message: `已存入 OneDrive：/${relPath}` });
        return;
      }

      if (conn.presetKey === 'gdrive') {
        if (!conn.secretToken) throw new Error('Google Drive 连接器缺少 OAuth Token');
        const boundary = `bcai_${Date.now()}`;
        const metadata = JSON.stringify({
          name: cleanFile,
          ...(conn.usernameOrId ? { parents: [conn.usernameOrId] } : {}),
        });
        const multipartBody = [
          `--${boundary}`,
          'Content-Type: application/json; charset=UTF-8',
          '',
          metadata,
          `--${boundary}`,
          'Content-Type: text/plain; charset=UTF-8',
          '',
          code,
          `--${boundary}--`,
        ].join('\r\n');
        const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${conn.secretToken}`,
            'content-type': `multipart/related; boundary=${boundary}`,
          },
          body: multipartBody,
        });
        if (!r.ok) throw new Error(`Google Drive 上传失败 (HTTP ${r.status})`);
        res.json({ ok: true, connectorName: conn.name, targetPath: cleanFile, message: `已存入 Google Drive：${cleanFile}` });
        return;
      }

      if (conn.presetKey === 'resend' && conn.usernameOrId && conn.secretToken) {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${conn.secretToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from: conn.usernameOrId,
            to: [conn.extraConfig || conn.usernameOrId],
            subject: `[BCAI 代码归档] ${cleanFile}`,
            text: `会话：${conversationTitle || 'BCAI 工作台'}\n语言：${lang}\n\n${code}`,
          }),
        });
        if (!r.ok) throw new Error(`Resend 发送失败 (HTTP ${r.status})`);
        res.json({ ok: true, connectorName: conn.name, targetPath: cleanFile, message: `已通过 Resend 邮件发送代码：${cleanFile}` });
        return;
      }

      // Generic Webhook / Deploy / Custom API endpoint
      if (!conn.endpoint) throw new Error('连接器未配置接收端点 URL');
      assertSafeExternalUrl(conn.endpoint);
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (conn.secretToken) headers.authorization = `Bearer ${conn.secretToken}`;
      const r = await fetch(conn.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          event: 'bcai.save_code',
          filename: cleanFile,
          path: relPath,
          lang,
          code,
          conversationTitle,
          savedAt: new Date().toISOString(),
        }),
      });
      if (!r.ok) throw new Error(`连接器端点返回 HTTP ${r.status}`);
      res.json({ ok: true, connectorName: conn.name, targetPath: relPath, message: `已推送代码到连接器「${conn.name}」` });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || '存入连接器失败' });
    }
  });

  // Download full source repository zip for manual git push / pull deployment
  app.get('/api/deploy/source-package.zip', async (_req, res) => {
    try {
      const zip = new JSZip();
      const addSourceDir = (fsDir: string, zipFolder: JSZip | null) => {
        for (const entry of fs.readdirSync(fsDir, { withFileTypes: true })) {
          if (['node_modules', 'dist', '.git', '.data', 'aistudio'].includes(entry.name)) continue;
          const full = path.join(fsDir, entry.name);
          if (entry.isDirectory()) {
            const sub = zipFolder ? zipFolder.folder(entry.name) : zip.folder(entry.name);
            addSourceDir(full, sub);
          } else if (entry.isFile()) {
            const data = fs.readFileSync(full);
            if (zipFolder) zipFolder.file(entry.name, data);
            else zip.file(entry.name, data);
          }
        }
      };
      addSourceDir(__dirname, null);
      const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="bcai-full-source.zip"');
      res.send(buffer);
    } catch (err: any) {
      res.status(500).json({ error: `生成源码包失败: ${err?.message}` });
    }
  });

  // Download specific ready-to-deploy config & guide files directly from the repository
  app.get('/api/deploy/repo-file', (req, res) => {
    const file = (req.query.name as string) || '';
    const ALLOWED_FILES: Record<string, string> = {
      'wrangler.toml': 'wrangler.toml',
      '_routes.json': '_routes.json',
      'schema.sql': 'schema.sql',
      'vercel.json': 'vercel.json',
      'edgeone.json': 'edgeone.json',
      'esa.jsonc': 'esa.jsonc',
      'netlify.toml': 'netlify.toml',
      'Dockerfile': 'Dockerfile',
      'docker-compose.yml': 'docker-compose.yml',
      'README.md': 'README.md',
      'DEPLOYMENT.md': 'docs/DEPLOYMENT.md',
    };
    const rel = ALLOWED_FILES[file];
    if (!rel) {
      res.status(404).json({ error: '不支持的文件名' });
      return;
    }
    const resolved = path.resolve(__dirname, rel);
    if (!resolved.startsWith(__dirname + path.sep) || !fs.existsSync(resolved)) {
      res.status(404).json({ error: '仓库内暂未找到该文件' });
      return;
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(rel)}"`);
    res.sendFile(resolved);
  });

  // Downloadable Multi-Cloud Pages Upload Bundle (.zip: dist/ + _worker.js + edgeone.json + esa.jsonc + wrangler.toml + schema.sql)
  app.get('/api/deploy/pages-package.zip', async (_req, res) => {
    try {
      const zip = new JSZip();

      const addDirToZip = (fsDir: string, zipFolder: JSZip | null) => {
        if (!fs.existsSync(fsDir)) return;
        for (const entry of fs.readdirSync(fsDir, { withFileTypes: true })) {
          const full = path.join(fsDir, entry.name);
          if (entry.isDirectory()) {
            const sub = zipFolder ? zipFolder.folder(entry.name) : zip.folder(entry.name);
            addDirToZip(full, sub);
          } else if (entry.isFile()) {
            const data = fs.readFileSync(full);
            if (zipFolder) zipFolder.file(entry.name, data);
            else zip.file(entry.name, data);
          }
        }
      };

      const distDir = path.join(__dirname, 'dist');
      if (!fs.existsSync(path.join(distDir, 'index.html'))) {
        const { build } = await import('vite');
        await build({ root: __dirname, logLevel: 'silent' });
      }
      addDirToZip(distDir, null);

      try {
        const esbuild = await import('esbuild');
        const workerEntry = path.join(__dirname, 'functions', '_worker-entry.ts');
        if (fs.existsSync(workerEntry)) {
          const built = await esbuild.build({
            entryPoints: [workerEntry],
            bundle: true,
            write: false,
            format: 'esm',
            target: 'es2022',
            platform: 'browser',
          });
          if (built.outputFiles?.[0]) {
            zip.file('_worker.js', built.outputFiles[0].contents);
          }
        }
      } catch {
        const fnFolder = zip.folder('functions');
        addDirToZip(path.join(__dirname, 'functions'), fnFolder);
      }

      for (const cfgFile of ['_routes.json', 'wrangler.toml', 'edgeone.json', 'esa.jsonc', 'netlify.toml', 'schema.sql', 'README.md']) {
        const p = path.join(__dirname, cfgFile);
        if (fs.existsSync(p)) {
          zip.file(cfgFile, fs.readFileSync(p));
        }
      }

      const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="bcai-pages-upload-bundle.zip"');
      res.send(buffer);
    } catch (err: any) {
      res.status(500).json({ error: `生成部署包失败: ${err?.message}` });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`BCAI server listening on http://0.0.0.0:${port}`);
  });
  server.requestTimeout = 0;
  server.timeout = 0;
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
}

createServer();

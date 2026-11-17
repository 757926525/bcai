import express, { type Request, type Response, type NextFunction } from 'express';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import JSZip from 'jszip';
import {
  s3DeleteObject,
  s3GetObject,
  s3ListObjects,
  s3PutObject,
  type S3Config,
} from './functions/_crypto-s3.ts';

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
  updatedAt?: string;
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

function getD1Config(): D1BindingConfig | null {
  if (process.env.CF_ACCOUNT_ID && process.env.CF_D1_DATABASE_ID && process.env.CF_API_TOKEN) {
    return {
      accountId: process.env.CF_ACCOUNT_ID,
      databaseId: process.env.CF_D1_DATABASE_ID,
      apiToken: process.env.CF_API_TOKEN,
    };
  }
  const saved = readJsonFile<D1BindingConfig | null>(D1_CFG_FILE, null);
  if (saved && saved.accountId && saved.databaseId && saved.apiToken) {
    return saved;
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
    return {
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION || 'auto',
      bucket: process.env.S3_BUCKET,
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    };
  }
  const saved = readJsonFile<S3Config | null>(BUCKET_CFG_FILE, null);
  if (saved && saved.endpoint && saved.bucket && saved.accessKeyId && saved.secretAccessKey) {
    return saved;
  }
  return null;
}

async function queryD1(cfg: D1BindingConfig, sql: string, params: unknown[] = []): Promise<any[]> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.accountId)}/d1/database/${encodeURIComponent(cfg.databaseId)}/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.apiToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  });
  const data = (await res.json()) as {
    success?: boolean;
    errors?: Array<{ message: string }>;
    result?: Array<{ results?: any[]; success?: boolean }>;
  };
  if (!res.ok || !data.success) {
    const errMsg = data?.errors?.[0]?.message || `D1 HTTP ${res.status}`;
    throw new Error(errMsg);
  }
  return data.result?.[0]?.results || [];
}

async function ensureD1Tables(cfg: D1BindingConfig): Promise<void> {
  await queryD1(
    cfg,
    `CREATE TABLE IF NOT EXISTS media_assets (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      prompt TEXT,
      model_id TEXT,
      content_data TEXT NOT NULL,
      repo_path TEXT,
      storage_location TEXT NOT NULL DEFAULT 'd1',
      bucket_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`
  );
  // Safe column migration for existing tables
  try {
    await queryD1(cfg, `ALTER TABLE media_assets ADD COLUMN storage_location TEXT NOT NULL DEFAULT 'd1'`);
  } catch {
    // column already exists
  }
  try {
    await queryD1(cfg, `ALTER TABLE media_assets ADD COLUMN bucket_key TEXT`);
  } catch {
    // column already exists
  }
  await queryD1(
    cfg,
    `CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      mode TEXT NOT NULL,
      model_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      repo_full_name TEXT,
      repo_branch TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      messages_json TEXT,
      storage_location TEXT NOT NULL DEFAULT 'd1',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`
  );
  try {
    await queryD1(cfg, `ALTER TABLE conversations ADD COLUMN messages_json TEXT`);
  } catch {
    // already exists
  }
}

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

function buildGeminiContents(messages: IncomingChatMessage[]): Array<{ role: string; parts: Array<Record<string, unknown>> }> {
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
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
      if (parts.length === 0) parts.push({ text: '' });
      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts,
      };
    });
}

async function createServer() {
  const app = express();
  app.use(express.json({ limit: '35mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, brand: 'BCAI', timestamp: new Date().toISOString() });
  });

  // Public environment capability discovery (never exposes secret values)
  app.get('/api/config/public', (req, res) => {
    const d1Cfg = getD1Config();
    const bucketCfg = getBucketConfig();
    const pwInfo = hasAnyAdminPassword();
    const isAdmin = isRequestAdmin(req);

    const openaiModelsRaw = process.env.OPENAI_MODELS || 'gpt-4o-mini';
    const openaiModels = openaiModelsRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    res.json({
      isAdmin,
      hasAdminPassword: pwInfo.hasPassword,
      usingEnvPassword: pwInfo.usingEnv,
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
      d1Bound: Boolean(d1Cfg),
      bucketBound: Boolean(bucketCfg),
      githubOAuthConfigured: Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
    });
  });

  // ==========================================
  // Admin Auth Routes (Default No Login Gate; Admin Unlocks Admin Tools)
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
      // First-time convenient setup if user entered a new password while none existed
      const salt = crypto.randomBytes(16).toString('hex');
      store.salt = salt;
      store.passwordHash = hashPassword(password.trim(), salt);
      store.updatedAt = new Date().toISOString();
      writeJsonFile(ADMIN_AUTH_FILE, store);
    }

    const token = signAdminSession(store.sessionSecret);
    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.cookie('bcai_admin', token, {
      httpOnly: true,
      secure: isHttps,
      sameSite: isHttps ? 'none' : 'lax',
      maxAge: 14 * 24 * 60 * 60 * 1000,
    });
    res.json({
      ok: true,
      isAdmin: true,
      adminToken: token,
      hasAdminPassword: hasAnyAdminPassword().hasPassword,
    });
  });

  app.post('/api/auth/admin-logout', (req, res) => {
    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.clearCookie('bcai_admin', { secure: isHttps, sameSite: isHttps ? 'none' : 'lax' });
    res.json({ ok: true, isAdmin: false });
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
        const probeModel = modelId || 'gemini-3.1-flash-lite';
        await ai.models.generateContent({
          model: probeModel,
          contents: 'Reply with OK',
        });
        res.json({ status: 'connected', latencyMs: Date.now() - start, message: `已连通 (${probeModel})` });
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
        message: err?.message || '网络探测失败',
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
    req.on('close', () => {
      if (!res.writableEnded) ac.abort();
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

        const systemMsg = messages.find((m) => m.role === 'system')?.content;
        const convo = buildGeminiContents(messages);

        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const isGemini4 = model.startsWith('gemini-4');
        const config: Record<string, unknown> = {};
        if (systemMsg) config.systemInstruction = systemMsg;
        if (!isGemini4 && typeof temperature === 'number') {
          config.temperature = temperature;
        }

        const stream = await ai.models.generateContentStream({
          model,
          contents: convo as any,
          config: Object.keys(config).length ? config : undefined,
        });

        for await (const chunk of stream) {
          if (ac.signal.aborted) break;
          const text = chunk.text || '';
          if (text) {
            res.write(`data: ${JSON.stringify({ response: text })}\n\n`);
          }
        }
        res.write('data: [DONE]\n\n');
        res.end();
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
        const upstream = await fetch(cfUrl, {
          method: 'POST',
          signal: ac.signal,
          headers: {
            authorization: `Bearer ${tok}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ messages: formattedMsgs, temperature, stream: true }),
        });

        if (!upstream.ok || !upstream.body) {
          const errText = await upstream.text();
          res.status(upstream.status).json({ error: errText || 'Workers AI 请求失败' });
          return;
        }

        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        const reader = upstream.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
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
      const upstream = await fetch(chatUrl, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model, messages: formattedMsgs, temperature, stream: true }),
      });

      if (!upstream.ok || !upstream.body) {
        const errText = await upstream.text();
        res.status(upstream.status).json({ error: errText || `上游返回 ${upstream.status}` });
        return;
      }

      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      const reader = upstream.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } catch (err: any) {
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

  // Image Generation Endpoint (Workers AI + Negative Prompt + CFG Guidance + Seed + optional Gemini translation)
  app.post('/api/image', async (req, res) => {
    const {
      prompt,
      negativePrompt = '',
      model = '@cf/black-forest-labs/flux-1-schnell',
      steps = 4,
      guidance = 7.5,
      seed,
      width = 1024,
      height = 1024,
      translate = true,
      accountId,
      apiKey,
    } = req.body as {
      prompt: string;
      negativePrompt?: string;
      model?: string;
      steps?: number;
      guidance?: number;
      seed?: string | number;
      width?: number;
      height?: number;
      translate?: boolean;
      accountId?: string;
      apiKey?: string;
    };

    if (!prompt) {
      res.status(400).json({ error: '请输入画面描述词' });
      return;
    }

    let finalPrompt = prompt;
    let finalNegative = (negativePrompt || '').trim();
    const acc = accountId || process.env.CF_ACCOUNT_ID || '';
    const tok = apiKey || process.env.CF_API_TOKEN || '';

    try {
      if (translate) {
        const ai = getGeminiClient();
        if (ai) {
          if (/[\u4e00-\u9fff]/.test(finalPrompt)) {
            try {
              const tr = await ai.models.generateContent({
                model: 'gemini-3.1-flash-lite',
                contents: `Translate this image generation prompt into concise, vivid English for FLUX/SDXL. Output ONLY the English prompt:\n${finalPrompt}`,
              });
              if (tr.text) finalPrompt = tr.text.trim();
            } catch {
              // fallback
            }
          }
          if (finalNegative && /[\u4e00-\u9fff]/.test(finalNegative)) {
            try {
              const trNeg = await ai.models.generateContent({
                model: 'gemini-3.1-flash-lite',
                contents: `Translate this image generation negative prompt (things to avoid) into concise comma-separated English tags. Output ONLY the English tags:\n${finalNegative}`,
              });
              if (trNeg.text) finalNegative = trNeg.text.trim();
            } catch {
              // fallback
            }
          }
        }
      }

      if (!acc || !tok) {
        res.status(400).json({
          error: '未配置 Cloudflare Workers AI 凭证（CF_ACCOUNT_ID / CF_API_TOKEN），请在设置区绑定或在 Cloudflare Pages 环境下使用内置 env.AI 免费绘图。',
        });
        return;
      }

      const input: Record<string, unknown> = { prompt: finalPrompt, num_steps: steps };
      if (!model.includes('flux')) {
        input.width = width;
        input.height = height;
        if (finalNegative) input.negative_prompt = finalNegative;
        if (typeof guidance === 'number' && !Number.isNaN(guidance)) input.guidance = guidance;
      }
      if (seed !== undefined && String(seed).trim() !== '' && !Number.isNaN(Number(seed))) {
        input.seed = Number(seed);
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
        const buf = Buffer.from(b64, 'base64');
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('x-final-prompt', encodeURIComponent(finalPrompt));
        res.send(buf);
        return;
      }

      const arrayBuf = await upstream.arrayBuffer();
      res.setHeader('Content-Type', ctype);
      res.setHeader('x-final-prompt', encodeURIComponent(finalPrompt));
      res.send(Buffer.from(arrayBuf));
    } catch (err: any) {
      res.status(500).json({ error: err?.message || '图像生成失败' });
    }
  });

  // ==========================================
  // Database (Cloudflare D1 Priority + Local Fallback) — Admin Only
  // ==========================================
  app.get('/api/db/status', requireAdmin, async (_req, res) => {
    const cfg = getD1Config();
    if (!cfg) {
      const local = readJsonFile<{ items: MediaAssetRecord[] }>(LOCAL_DB_FILE, { items: [] });
      res.json({
        mode: 'local-fallback',
        connected: false,
        d1Bound: false,
        label: '未绑定远程 D1（当前使用本地持久化 .data/bcai-db.json）',
        itemCount: local.items.length,
      });
      return;
    }

    try {
      await ensureD1Tables(cfg);
      const rows = await queryD1(cfg, 'SELECT COUNT(*) as cnt FROM media_assets');
      const count = rows?.[0]?.cnt ?? 0;
      res.json({
        mode: 'cloudflare-d1-http',
        connected: true,
        d1Bound: true,
        accountIdMasked: `${cfg.accountId.slice(0, 6)}...`,
        databaseIdMasked: `${cfg.databaseId.slice(0, 8)}...`,
        label: 'Cloudflare D1 远程数据库已连通',
        itemCount: Number(count),
      });
    } catch (err: any) {
      res.json({
        mode: 'cloudflare-d1-http',
        connected: false,
        d1Bound: true,
        label: `Cloudflare D1 连接异常: ${err?.message || '请检查凭证或建表'}`,
        error: err?.message,
      });
    }
  });

  app.post('/api/db/config', requireAdmin, async (req, res) => {
    const { accountId, databaseId, apiToken, clear } = req.body as {
      accountId?: string;
      databaseId?: string;
      apiToken?: string;
      clear?: boolean;
    };

    if (clear) {
      if (fs.existsSync(D1_CFG_FILE)) fs.unlinkSync(D1_CFG_FILE);
      res.json({ ok: true, mode: 'local-fallback' });
      return;
    }

    if (!accountId || !databaseId || !apiToken) {
      res.status(400).json({ error: '请填写完整的 Account ID、D1 Database ID 和 API Token' });
      return;
    }

    const cfg: D1BindingConfig = {
      accountId: accountId.trim(),
      databaseId: databaseId.trim(),
      apiToken: apiToken.trim(),
    };
    try {
      await ensureD1Tables(cfg);
      writeJsonFile(D1_CFG_FILE, cfg);
      res.json({
        ok: true,
        mode: 'cloudflare-d1-http',
        message: 'D1 绑定成功并已自动初始化 media_assets 与 conversations 表结构',
      });
    } catch (err: any) {
      res.status(400).json({ error: `D1 验证或建表失败: ${err?.message || '未知错误'}` });
    }
  });

  app.get('/api/db/items', requireAdmin, async (req, res) => {
    const typeFilter = (req.query.type as string) || '';
    const cfg = getD1Config();
    if (cfg) {
      try {
        await ensureD1Tables(cfg);
        const rows = typeFilter
          ? await queryD1(cfg, 'SELECT * FROM media_assets WHERE type = ? ORDER BY updated_at DESC LIMIT 100', [typeFilter])
          : await queryD1(cfg, 'SELECT * FROM media_assets ORDER BY updated_at DESC LIMIT 100');
        const normalized = rows.map((r) => ({ ...r, storage_location: r.storage_location || 'd1' }));
        res.json({ mode: 'cloudflare-d1-http', items: normalized });
        return;
      } catch (err: any) {
        res.status(500).json({ error: `读取 D1 失败: ${err?.message}` });
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
    const cfg = getD1Config();
    const storageLoc: 'd1' | 'bucket' | 'local' = body.storageLocation || (cfg ? 'd1' : 'local');

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
      storage_location: storageLoc,
      bucket_key: body.bucketKey || '',
      created_at: now,
      updated_at: now,
    };

    if (cfg) {
      try {
        await ensureD1Tables(cfg);
        await queryD1(
          cfg,
          `INSERT OR REPLACE INTO media_assets
           (id, type, name, mime_type, size_bytes, prompt, model_id, content_data, repo_path, storage_location, bucket_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            record.id,
            record.type,
            record.name,
            record.mime_type,
            record.size_bytes,
            record.prompt,
            record.model_id,
            record.content_data,
            record.repo_path,
            record.storage_location,
            record.bucket_key,
            record.created_at,
            record.updated_at,
          ]
        );
        res.json({ ok: true, mode: 'cloudflare-d1-http', storageLocation: record.storage_location, item: record });
        return;
      } catch (err: any) {
        res.status(500).json({ error: `写入 D1 失败: ${err?.message}` });
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
    const cfg = getD1Config();
    if (cfg) {
      try {
        await queryD1(cfg, 'DELETE FROM media_assets WHERE id = ?', [id]);
        res.json({ ok: true });
        return;
      } catch (err: any) {
        res.status(500).json({ error: `删除 D1 记录失败: ${err?.message}` });
        return;
      }
    }
    const local = readJsonFile<{ items: MediaAssetRecord[] }>(LOCAL_DB_FILE, { items: [] });
    local.items = local.items.filter((i) => i.id !== id);
    writeJsonFile(LOCAL_DB_FILE, local);
    res.json({ ok: true });
  });

  // ==========================================
  // Storage Bucket (Cloudflare R2 / S3-Compatible HTTP) — Admin Only
  // ==========================================
  app.get('/api/bucket/status', requireAdmin, async (_req, res) => {
    const cfg = getBucketConfig();
    if (!cfg) {
      res.json({
        configured: false,
        connected: false,
        mode: 'unconfigured',
        label: '未绑定对象存储桶（请配置 Cloudflare R2 或 S3 兼容存储桶）',
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
    const { endpoint, region = 'auto', bucket, accessKeyId, secretAccessKey, clear } = req.body as {
      endpoint?: string;
      region?: string;
      bucket?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      clear?: boolean;
    };

    if (clear) {
      if (fs.existsSync(BUCKET_CFG_FILE)) fs.unlinkSync(BUCKET_CFG_FILE);
      res.json({ ok: true, message: '已清除存储桶配置' });
      return;
    }

    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
      res.status(400).json({ error: '请填写完整的 S3/R2 Endpoint、Bucket 名称、Access Key ID 与 Secret Access Key' });
      return;
    }

    const cfg: S3Config = {
      endpoint: endpoint.trim(),
      region: (region || 'auto').trim(),
      bucket: bucket.trim(),
      accessKeyId: accessKeyId.trim(),
      secretAccessKey: secretAccessKey.trim(),
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

      // Record metadata in D1/local with storage_location='bucket'
      const d1Cfg = getD1Config();
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
      if (d1Cfg) {
        try {
          await ensureD1Tables(d1Cfg);
          await queryD1(
            d1Cfg,
            `INSERT OR REPLACE INTO media_assets
             (id, type, name, mime_type, size_bytes, prompt, model_id, content_data, repo_path, storage_location, bucket_key, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              record.id,
              record.type,
              record.name,
              record.mime_type,
              record.size_bytes,
              record.prompt,
              record.model_id,
              record.content_data,
              '',
              'bucket',
              key,
              now,
              now,
            ]
          );
        } catch {
          // ignore D1 index write failure if bucket succeeded
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
      const d1Cfg = getD1Config();
      if (d1Cfg) {
        try {
          await queryD1(d1Cfg, 'DELETE FROM media_assets WHERE bucket_key = ?', [key]);
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
  // Conversation History Sync (D1 + Storage Bucket) — Admin Only
  // ==========================================
  app.post('/api/sync/conversations', requireAdmin, async (req, res) => {
    const { conversations = [], target = 'auto' } = req.body as {
      conversations?: any[];
      target?: 'auto' | 'd1' | 'bucket' | 'both';
    };
    const d1Cfg = getD1Config();
    const bucketCfg = getBucketConfig();

    const wantD1 = target === 'd1' || target === 'both' || (target === 'auto' && Boolean(d1Cfg));
    const wantBucket = target === 'bucket' || target === 'both' || (target === 'auto' && Boolean(bucketCfg));

    if (!wantD1 && !wantBucket) {
      res.status(400).json({
        ok: false,
        error: '尚未绑定 Cloudflare D1 数据库或对象存储桶，请先完成至少一项绑定后再同步对话历史。',
      });
      return;
    }

    const now = new Date().toISOString();
    const results: { d1: boolean; bucket: boolean; errors: string[] } = {
      d1: false,
      bucket: false,
      errors: [],
    };

    if (wantD1) {
      if (!d1Cfg) {
        results.errors.push('未配置 D1 数据库');
      } else {
        try {
          await ensureD1Tables(d1Cfg);
          for (const c of conversations.slice(0, 80)) {
            await queryD1(
              d1Cfg,
              `INSERT OR REPLACE INTO conversations
               (id, title, mode, model_id, provider_id, repo_full_name, repo_branch, status, messages_json, storage_location, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'd1', ?, ?)`,
              [
                c.id,
                c.title || '未命名会话',
                c.mode || 'chat',
                c.modelId || '',
                c.providerId || '',
                c.repoFullName || '',
                c.repoBranch || '',
                c.status || 'active',
                JSON.stringify(c.messages || []),
                c.createdAt || now,
                c.updatedAt || now,
              ]
            );
          }
          results.d1 = true;
        } catch (err: any) {
          results.errors.push(`D1 同步失败: ${err?.message}`);
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
    res.status(ok ? 200 : 500).json({
      ok,
      syncedAt: now,
      count: conversations.length,
      targets: { d1: results.d1, bucket: results.bucket },
      errors: results.errors,
      message: ok
        ? `已成功同步 ${conversations.length} 个会话至 ${[results.d1 ? 'Cloudflare D1' : '', results.bucket ? '存储桶' : ''].filter(Boolean).join(' + ')}`
        : results.errors.join('；'),
    });
  });

  app.get('/api/sync/conversations', requireAdmin, async (req, res) => {
    const source = (req.query.source as string) || 'auto';
    const d1Cfg = getD1Config();
    const bucketCfg = getBucketConfig();

    if ((source === 'bucket' || (source === 'auto' && !d1Cfg && bucketCfg)) && bucketCfg) {
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

    if (d1Cfg) {
      try {
        await ensureD1Tables(d1Cfg);
        const rows = await queryD1(d1Cfg, 'SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 80');
        const conversations = rows.map((r) => ({
          id: r.id,
          title: r.title,
          mode: r.mode || 'chat',
          modelId: r.model_id,
          providerId: r.provider_id,
          repoFullName: r.repo_full_name || undefined,
          repoBranch: r.repo_branch || undefined,
          status: r.status || 'active',
          messages: r.messages_json ? JSON.parse(r.messages_json) : [],
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        }));
        res.json({ ok: true, source: 'd1', conversations, syncedAt: new Date().toISOString() });
        return;
      } catch (err: any) {
        res.status(500).json({ error: `从 D1 拉取失败: ${err?.message}` });
        return;
      }
    }

    res.status(400).json({ error: '尚未绑定 D1 数据库或对象存储桶' });
  });

  // ==========================================
  // Multi-Git Provider APIs (GitHub, GitLab, Gitee) — Admin Only
  // ==========================================
  app.get('/api/auth/github/url', (req, res) => {
    const clientId = process.env.GITHUB_CLIENT_ID;
    if (!clientId) {
      res.status(400).json({
        error: '未配置 GITHUB_CLIENT_ID 环境变量。可直接使用 Token 方式连接，或在环境变量设置 GITHUB_CLIENT_ID 与 GITHUB_CLIENT_SECRET。',
      });
      return;
    }
    const redirectUri = `${getAppUrl(req)}/auth/callback`;
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'repo read:user',
    });
    res.json({ url: `https://github.com/login/oauth/authorize?${params.toString()}`, redirectUri });
  });

  const handleGitHubCallback = async (req: Request, res: Response) => {
    const code = req.query.code as string | undefined;
    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;
    if (!code || !clientId || !clientSecret) {
      res.status(400).send('缺少授权码 code 或 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET');
      return;
    }
    try {
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: `${getAppUrl(req)}/auth/callback`,
        }),
      });
      const tokenJson = (await tokenRes.json()) as { access_token?: string; error_description?: string; error?: string };
      if (!tokenJson.access_token) {
        res.status(400).send(`GitHub 授权失败: ${tokenJson.error_description || tokenJson.error || '未知错误'}`);
        return;
      }

      const userRes = await fetch('https://api.github.com/user', {
        headers: { authorization: `Bearer ${tokenJson.access_token}`, 'user-agent': 'bcai-workbench' },
      });
      const user = await userRes.json();

      res.cookie('aimx_gh_token', tokenJson.access_token, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: 14 * 24 * 60 * 60 * 1000,
      });

      res.send(`<!doctype html>
        <html lang="zh-CN">
          <head><meta charset="utf-8"><title>GitHub 授权完成</title></head>
          <body style="font-family:system-ui,sans-serif;padding:24px;text-align:center;">
            <script>
              if (window.opener) {
                window.opener.postMessage({
                  type: 'OAUTH_AUTH_SUCCESS',
                  provider: 'github',
                  user: ${JSON.stringify(user)},
                  token: ${JSON.stringify(tokenJson.access_token)}
                }, '*');
                window.close();
              } else {
                window.location.href = '/';
              }
            </script>
            <p>GitHub 授权成功，正在返回 BCAI 工作台...</p>
          </body>
        </html>`);
    } catch (err: any) {
      res.status(500).send(`OAuth 处理失败: ${err?.message}`);
    }
  };

  app.get(['/auth/callback', '/auth/callback/'], handleGitHubCallback);

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
        res.cookie('aimx_gh_token', cleanToken, {
          httpOnly: true,
          secure: true,
          sameSite: 'none',
          maxAge: 14 * 24 * 60 * 60 * 1000,
        });
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
      res.clearCookie('aimx_gh_token', { secure: true, sameSite: 'none' });
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

      // Generic Google Drive / OneDrive / Webhook / Custom endpoint probe
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

  // Downloadable Cloudflare Pages Upload Package (.zip)
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

      for (const cfgFile of ['_routes.json', 'wrangler.toml', 'schema.sql', 'README.md']) {
        const p = path.join(__dirname, cfgFile);
        if (fs.existsSync(p)) {
          zip.file(cfgFile, fs.readFileSync(p));
        }
      }

      zip.file(
        'DEPLOY_PAGES_GUIDE.txt',
        [
          'BCAI Cloudflare Pages 上传部署包说明',
          '====================================',
          '1. 网页直接上传（Dashboard Upload Assets）:',
          '   本压缩包根目录已内置完整编译后的静态前端与 _worker.js 全栈边缘服务端。',
          '   直接将本 .zip 文件上传到 Cloudflare Dashboard -> Workers & Pages -> Create -> Pages -> Upload assets 即可运行！',
          '2. Wrangler CLI 上传:',
          '   解压后在目录内执行: npx wrangler pages deploy . --project-name=bcai',
          '3. 绑定 Workers AI、D1 数据库与 R2 存储桶:',
          '   进入 Pages 项目 Settings -> Functions:',
          '   - Workers AI Binding 变量名设为: AI',
          '   - D1 Database Binding 变量名设为: DB (首次建表执行 npx wrangler d1 execute bcai-db --remote --file=./schema.sql)',
          '   - R2 Bucket Binding 变量名设为: BUCKET',
        ].join('\n')
      );

      const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="bcai-cloudflare-pages-deploy.zip"');
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
  app.listen(port, '0.0.0.0', () => {
    console.log(`BCAI server listening on http://0.0.0.0:${port}`);
  });
}

createServer();

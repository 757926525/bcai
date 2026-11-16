import express, { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import JSZip from 'jszip';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '.data');
const LOCAL_DB_FILE = path.join(DATA_DIR, 'aimx-db.json');
const D1_CFG_FILE = path.join(DATA_DIR, 'd1-config.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
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
  created_at: string;
  updated_at: string;
}

interface D1BindingConfig {
  accountId: string;
  databaseId: string;
  apiToken: string;
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

function requireAccess(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.ACCESS_PASSWORD;
  if (!expected) {
    next();
    return;
  }
  const cookies = parseCookies(req);
  const rawHeader = (req.headers['x-access-password'] as string) || '';
  let decodedHeader = rawHeader;
  try {
    decodedHeader = decodeURIComponent(rawHeader);
  } catch {
    decodedHeader = rawHeader;
  }
  if (decodedHeader === expected || cookies['aimx_access'] === expected) {
    next();
    return;
  }
  res.status(401).json({ error: '访问密码无效或未登录，请先在计划登录面板验证。' });
}

function getAppUrl(req: Request): string {
  if (process.env.APP_URL && process.env.APP_URL !== 'MY_APP_URL') {
    return process.env.APP_URL.replace(/\/+$/, '');
  }
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
  return `${proto}://${host}`;
}

function getGitHubToken(req: Request): string {
  const headerToken = (req.headers['x-github-token'] as string) || '';
  if (headerToken) return headerToken.trim();
  const bodyToken = (req.body && typeof req.body.token === 'string' ? req.body.token : '') || '';
  if (bodyToken) return bodyToken.trim();
  const cookies = parseCookies(req);
  if (cookies['aimx_gh_token']) return cookies['aimx_gh_token'].trim();
  return (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
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

async function createServer() {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
  });

  // Public environment capability discovery (never exposes secret values)
  app.get('/api/config/public', (req, res) => {
    const cookies = parseCookies(req);
    const d1Cfg = getD1Config();
    const expectedPw = process.env.ACCESS_PASSWORD || '';
    const unlocked = !expectedPw || cookies['aimx_access'] === expectedPw;

    const openaiModelsRaw = process.env.OPENAI_MODELS || 'gpt-4o-mini';
    const openaiModels = openaiModelsRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    res.json({
      requiresPassword: Boolean(expectedPw),
      unlocked,
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
      githubOAuthConfigured: Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
    });
  });

  // Plan & Login Panel session routes
  app.post('/api/auth/login', (req, res) => {
    const { password, plan = 'free' } = req.body as { password?: string; plan?: string };
    const expected = process.env.ACCESS_PASSWORD || '';
    if (expected && password !== expected) {
      res.status(401).json({ error: '访问密码错误' });
      return;
    }
    if (expected) {
      res.cookie('aimx_access', expected, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
    }
    res.cookie('aimx_plan', plan, {
      httpOnly: false,
      secure: true,
      sameSite: 'none',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    res.json({ ok: true, unlocked: true, plan });
  });

  app.post('/api/auth/logout', (_req, res) => {
    res.clearCookie('aimx_access', { secure: true, sameSite: 'none' });
    res.json({ ok: true });
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

      // OpenAI-compatible (deepseek, groq, openrouter, openai-compatible)
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

  // Unified SSE Chat Proxy Endpoint
  app.post('/api/chat', requireAccess, async (req, res) => {
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
      messages: Array<{ role: string; content: string }>;
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
      // 1. Google Gemini via @google/genai SDK (server-side)
      if (providerType === 'gemini') {
        const ai = source === 'custom' && apiKey
          ? new GoogleGenAI({ apiKey, httpOptions: { headers: { 'User-Agent': 'aistudio-build' } } })
          : getGeminiClient();

        if (!ai) {
          res.status(400).json({ error: '未配置 GEMINI_API_KEY。请在 AI Studio Secrets 或环境变量中设置。' });
          return;
        }

        const systemMsg = messages.find((m) => m.role === 'system')?.content;
        const convo = messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          }));

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
          contents: convo,
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

        const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(acc)}/ai/run/${model}`;
        const upstream = await fetch(cfUrl, {
          method: 'POST',
          signal: ac.signal,
          headers: {
            authorization: `Bearer ${tok}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ messages, temperature, stream: true }),
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
        res.status(400).json({ error: `未配置 ${providerType} 的 API Key，请在设置区添加外接 API 或配置环境变量。` });
        return;
      }

      const cleanBase = targetBase.replace(/\/+$/, '');
      const chatUrl = cleanBase.endsWith('/chat/completions') ? cleanBase : `${cleanBase}/chat/completions`;
      const upstream = await fetch(chatUrl, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model, messages, temperature, stream: true }),
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

  // Image Generation Endpoint (Cloudflare Workers AI + optional Gemini translation)
  app.post('/api/image', requireAccess, async (req, res) => {
    const {
      prompt,
      model = '@cf/black-forest-labs/flux-1-schnell',
      steps = 4,
      width = 1024,
      height = 1024,
      translate = true,
      accountId,
      apiKey,
    } = req.body as {
      prompt: string;
      model?: string;
      steps?: number;
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
    const hasCjk = /[\u4e00-\u9fff]/.test(finalPrompt);
    const acc = accountId || process.env.CF_ACCOUNT_ID || '';
    const tok = apiKey || process.env.CF_API_TOKEN || '';

    try {
      if (translate && hasCjk) {
        const ai = getGeminiClient();
        if (ai) {
          try {
            const tr = await ai.models.generateContent({
              model: 'gemini-3.1-flash-lite',
              contents: `Translate this image generation prompt into concise, vivid English for FLUX/SDXL. Output ONLY the English prompt:\n${finalPrompt}`,
            });
            if (tr.text) finalPrompt = tr.text.trim();
          } catch {
            // fallback to original
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
  // Database (Cloudflare D1 Priority + Local Fallback)
  // ==========================================
  app.get('/api/db/status', requireAccess, async (_req, res) => {
    const cfg = getD1Config();
    if (!cfg) {
      const local = readJsonFile<{ items: MediaAssetRecord[] }>(LOCAL_DB_FILE, { items: [] });
      res.json({
        mode: 'local-fallback',
        connected: true,
        d1Bound: false,
        label: '本地持久化存储 (.data/aimx-db.json)',
        itemCount: local.items.length,
      });
      return;
    }

    try {
      const rows = await queryD1(cfg, "SELECT COUNT(*) as cnt FROM media_assets");
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

  app.post('/api/db/config', requireAccess, async (req, res) => {
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

    const cfg: D1BindingConfig = { accountId: accountId.trim(), databaseId: databaseId.trim(), apiToken: apiToken.trim() };
    try {
      // Auto-initialize schema on the target D1 database
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
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`
      );
      writeJsonFile(D1_CFG_FILE, cfg);
      res.json({ ok: true, mode: 'cloudflare-d1-http', message: 'D1 绑定成功并已自动校验 media_assets 表结构' });
    } catch (err: any) {
      res.status(400).json({ error: `D1 验证或建表失败: ${err?.message || '未知错误'}` });
    }
  });

  app.get('/api/db/items', requireAccess, async (req, res) => {
    const typeFilter = (req.query.type as string) || '';
    const cfg = getD1Config();
    if (cfg) {
      try {
        const rows = typeFilter
          ? await queryD1(cfg, 'SELECT * FROM media_assets WHERE type = ? ORDER BY updated_at DESC LIMIT 100', [typeFilter])
          : await queryD1(cfg, 'SELECT * FROM media_assets ORDER BY updated_at DESC LIMIT 100');
        res.json({ mode: 'cloudflare-d1-http', items: rows });
        return;
      } catch (err: any) {
        res.status(500).json({ error: `读取 D1 失败: ${err?.message}` });
        return;
      }
    }

    const local = readJsonFile<{ items: MediaAssetRecord[] }>(LOCAL_DB_FILE, { items: [] });
    const items = typeFilter ? local.items.filter((i) => i.type === typeFilter) : local.items;
    res.json({ mode: 'local-fallback', items });
  });

  app.post('/api/db/items', requireAccess, async (req, res) => {
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
    };
    const now = new Date().toISOString();
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
      created_at: now,
      updated_at: now,
    };

    const cfg = getD1Config();
    if (cfg) {
      try {
        await queryD1(
          cfg,
          `INSERT OR REPLACE INTO media_assets
           (id, type, name, mime_type, size_bytes, prompt, model_id, content_data, repo_path, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            record.created_at,
            record.updated_at,
          ]
        );
        res.json({ ok: true, mode: 'cloudflare-d1-http', item: record });
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
    res.json({ ok: true, mode: 'local-fallback', item: record });
  });

  app.delete('/api/db/items/:id', requireAccess, async (req, res) => {
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
  // GitHub OAuth & Repository APIs
  // ==========================================
  app.get('/api/auth/github/url', (req, res) => {
    const clientId = process.env.GITHUB_CLIENT_ID;
    if (!clientId) {
      res.status(400).json({
        error: '未配置 GITHUB_CLIENT_ID 环境变量。可直接使用下方 Personal Access Token (PAT) 方式连接，或在 Secrets 中配置 GITHUB_CLIENT_ID 与 GITHUB_CLIENT_SECRET。',
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
        headers: { authorization: `Bearer ${tokenJson.access_token}`, 'user-agent': 'aimx-workbench' },
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
            <p>GitHub 授权成功，正在返回 AIMX 工作台...</p>
          </body>
        </html>`);
    } catch (err: any) {
      res.status(500).send(`OAuth 处理失败: ${err?.message}`);
    }
  };

  app.get(['/auth/callback', '/auth/callback/'], handleGitHubCallback);

  app.post('/api/github/token', async (req, res) => {
    const { token } = req.body as { token?: string };
    if (!token) {
      res.status(400).json({ error: '请输入 GitHub Personal Access Token' });
      return;
    }
    try {
      const r = await fetch('https://api.github.com/user', {
        headers: { authorization: `Bearer ${token.trim()}`, 'user-agent': 'aimx-workbench' },
      });
      if (!r.ok) {
        res.status(401).json({ error: `GitHub 验证失败 (HTTP ${r.status})` });
        return;
      }
      const user = await r.json();
      res.cookie('aimx_gh_token', token.trim(), {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: 14 * 24 * 60 * 60 * 1000,
      });
      res.json({ ok: true, user });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'GitHub 连接失败' });
    }
  });

  app.post('/api/github/disconnect', (_req, res) => {
    res.clearCookie('aimx_gh_token', { secure: true, sameSite: 'none' });
    res.json({ ok: true });
  });

  app.get('/api/github/status', async (req, res) => {
    const token = getGitHubToken(req);
    if (!token) {
      res.json({ connected: false });
      return;
    }
    try {
      const r = await fetch('https://api.github.com/user', {
        headers: { authorization: `Bearer ${token}`, 'user-agent': 'aimx-workbench' },
      });
      if (!r.ok) {
        res.json({ connected: false });
        return;
      }
      const user = await r.json();
      res.json({ connected: true, user });
    } catch {
      res.json({ connected: false });
    }
  });

  app.get('/api/github/repos', async (req, res) => {
    const token = getGitHubToken(req);
    if (!token) {
      res.status(401).json({ error: '未连接 GitHub 账号' });
      return;
    }
    try {
      const r = await fetch('https://api.github.com/user/repos?sort=updated&per_page=50&affiliation=owner,collaborator,organization_member', {
        headers: { authorization: `Bearer ${token}`, 'user-agent': 'aimx-workbench' },
      });
      const data = await r.json();
      res.status(r.status).json({ repos: Array.isArray(data) ? data : [], raw: data });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  app.get('/api/github/branches', async (req, res) => {
    const repo = req.query.repo as string;
    const token = getGitHubToken(req);
    if (!repo) {
      res.status(400).json({ error: '缺少 repo 参数' });
      return;
    }
    try {
      const headers: Record<string, string> = { 'user-agent': 'aimx-workbench' };
      if (token) headers.authorization = `Bearer ${token}`;
      const r = await fetch(`https://api.github.com/repos/${repo}/branches?per_page=100`, { headers });
      const data = await r.json();
      res.status(r.status).json({ branches: Array.isArray(data) ? data : [] });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  app.get('/api/github/tree', async (req, res) => {
    const repo = req.query.repo as string;
    const branch = (req.query.branch as string) || 'main';
    const token = getGitHubToken(req);
    if (!repo) {
      res.status(400).json({ error: '缺少 repo 参数' });
      return;
    }
    try {
      const headers: Record<string, string> = { 'user-agent': 'aimx-workbench' };
      if (token) headers.authorization = `Bearer ${token}`;
      const r = await fetch(`https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, { headers });
      const data = (await r.json()) as { tree?: any[]; message?: string };
      if (!r.ok) {
        res.status(r.status).json({ error: data?.message || '读取目录树失败' });
        return;
      }
      res.json({ tree: data.tree || [] });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  app.get('/api/github/file', async (req, res) => {
    const repo = req.query.repo as string;
    const filePath = req.query.path as string;
    const branch = (req.query.branch as string) || 'main';
    const token = getGitHubToken(req);
    if (!repo || !filePath) {
      res.status(400).json({ error: '缺少 repo 或 path 参数' });
      return;
    }
    try {
      const headers: Record<string, string> = { 'user-agent': 'aimx-workbench' };
      if (token) headers.authorization = `Bearer ${token}`;
      const r = await fetch(
        `https://api.github.com/repos/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`,
        { headers }
      );
      const data = (await r.json()) as { content?: string; sha?: string; size?: number; encoding?: string; message?: string };
      if (!r.ok) {
        res.status(r.status).json({ error: data?.message || '读取文件失败' });
        return;
      }
      const decoded = data.content ? Buffer.from(data.content, 'base64').toString('utf-8') : '';
      res.json({ path: filePath, sha: data.sha, size: data.size, content: decoded });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  app.post('/api/github/branch', async (req, res) => {
    const { repo, newBranch, fromBranch = 'main' } = req.body as {
      repo: string;
      newBranch: string;
      fromBranch?: string;
    };
    const token = getGitHubToken(req);
    if (!token) {
      res.status(401).json({ error: '创建分支需要先授权连接 GitHub' });
      return;
    }
    try {
      const refRes = await fetch(`https://api.github.com/repos/${repo}/git/ref/heads/${encodeURIComponent(fromBranch)}`, {
        headers: { authorization: `Bearer ${token}`, 'user-agent': 'aimx-workbench' },
      });
      const refData = (await refRes.json()) as { object?: { sha: string }; message?: string };
      if (!refRes.ok || !refData?.object?.sha) {
        res.status(refRes.status).json({ error: refData?.message || '获取源分支 SHA 失败' });
        return;
      }
      const createRes = await fetch(`https://api.github.com/repos/${repo}/git/refs`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'user-agent': 'aimx-workbench',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ref: `refs/heads/${newBranch}`,
          sha: refData.object.sha,
        }),
      });
      const createData = await createRes.json();
      if (!createRes.ok) {
        res.status(createRes.status).json({ error: (createData as any)?.message || '创建分支失败' });
        return;
      }
      res.json({ ok: true, branch: newBranch, data: createData });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  app.put('/api/github/file', async (req, res) => {
    const { repo, path: filePath, content, message, branch = 'main', sha } = req.body as {
      repo: string;
      path: string;
      content: string;
      message?: string;
      branch?: string;
      sha?: string;
    };
    const token = getGitHubToken(req);
    if (!token) {
      res.status(401).json({ error: '写入推送文件需要先授权连接 GitHub' });
      return;
    }
    try {
      let currentSha = sha;
      if (!currentSha) {
        const check = await fetch(
          `https://api.github.com/repos/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`,
          { headers: { authorization: `Bearer ${token}`, 'user-agent': 'aimx-workbench' } }
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
            'user-agent': 'aimx-workbench',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            message: message || `Update ${filePath} via AIMX Workbench`,
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
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // Sync full project files to connected GitHub repository (atomic single commit, works on empty repos too)
  app.post('/api/github/sync-project', async (req, res) => {
    const {
      repo = '757926525/aimx',
      branch = 'main',
      commitMessage = 'feat: AIMX AI Workbench full-stack & Cloudflare Pages project',
    } = req.body as {
      repo?: string;
      branch?: string;
      commitMessage?: string;
      token?: string;
    };
    const token = getGitHubToken(req);
    if (!token) {
      res.status(401).json({
        error: '缺少 GitHub 推送凭证：请先在页面输入 GitHub Token (含 repo 权限) 或通过 OAuth 授权后再重试推送。',
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

    const ghFetch = async (urlPath: string, init: RequestInit = {}) => {
      const r = await fetch(`https://api.github.com${urlPath}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          'user-agent': 'aimx-workbench',
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          ...(init.headers || {}),
        },
      });
      const json = (await r.json().catch(() => ({}))) as any;
      return { ok: r.ok, status: r.status, json };
    };

    try {
      const files = collectFiles(__dirname);
      if (files.length === 0) {
        res.status(400).json({ error: '未收集到可推送的项目源码文件' });
        return;
      }

      // 1. Check if branch ref exists; if repo is empty, initialize with README.md first
      let refRes = await ghFetch(`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
      if (!refRes.ok) {
        const readmeFile = files.find((f) => f.relPath === 'README.md') || files[0];
        const initRes = await ghFetch(
          `/repos/${repo}/contents/${readmeFile.relPath.split('/').map(encodeURIComponent).join('/')}`,
          {
            method: 'PUT',
            body: JSON.stringify({
              message: 'chore: initialize AIMX repository',
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

      // 2. Upload all blobs in parallel batches of 6
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

      // 3. Create single atomic Git Tree & Commit & update branch ref
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
      res.setHeader('Content-Disposition', 'attachment; filename="aimx-full-source.zip"');
      res.send(buffer);
    } catch (err: any) {
      res.status(500).json({ error: `生成源码包失败: ${err?.message}` });
    }
  });

  // ==========================================
  // Downloadable Cloudflare Pages Upload Package (.zip)
  // ==========================================
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
      if (fs.existsSync(distDir)) {
        addDirToZip(distDir, null);
      } else {
        // Provide index.html + README notice if dist hasn't been built yet
        zip.file('index.html', fs.readFileSync(path.join(__dirname, 'index.html')));
      }

      // Include Cloudflare Pages Functions & config files inside the upload package
      const fnFolder = zip.folder('functions');
      addDirToZip(path.join(__dirname, 'functions'), fnFolder);

      for (const cfgFile of ['_routes.json', 'wrangler.toml', 'schema.sql', 'README.md', 'package.json', '.env.example']) {
        const p = path.join(__dirname, cfgFile);
        if (fs.existsSync(p)) {
          zip.file(cfgFile, fs.readFileSync(p));
        }
      }

      zip.file(
        'DEPLOY_PAGES_GUIDE.txt',
        [
          'AIMX Cloudflare Pages 上传部署包说明',
          '====================================',
          '1. 若通过 Wrangler CLI 直接上传:',
          '   npx wrangler pages deploy . --project-name=aimx',
          '2. 若通过 Cloudflare Dashboard 网页上传静态资源:',
          '   将根目录下的静态文件 (index.html, assets/) 上传到 Pages；',
          '   如需完整 functions/ 后端绑定 (Workers AI 与 D1)，推荐使用 Wrangler CLI 部署本目录或连接 Git 仓库 https://github.com/757926525/aimx。',
          '3. D1 数据库建表命令:',
          '   npx wrangler d1 execute aimx-db --remote --file=./schema.sql',
        ].join('\n')
      );

      const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="aimx-cloudflare-pages-deploy.zip"');
      res.send(buffer);
    } catch (err: any) {
      res.status(500).json({ error: `生成部署包失败: ${err?.message}` });
    }
  });

  // Vite middleware in dev / static dist in production
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
    console.log(`AIMX server listening on http://0.0.0.0:${port}`);
  });
}

createServer();

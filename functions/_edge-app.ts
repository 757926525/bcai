import { s3DeleteObject, s3GetObject, s3ListObjects, s3PutObject, sha256Hex, type S3Config } from './_crypto-s3';
import { type CFEnv } from './_types';

function jsonRes(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.get('cookie') || '';
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

function getAppUrl(req: Request, env: CFEnv): string {
  if (env.APP_URL && env.APP_URL !== 'MY_APP_URL') {
    return env.APP_URL.replace(/\/+$/, '');
  }
  const u = new URL(req.url);
  return `${u.protocol}//${u.host}`;
}

function getS3ConfigFromEnv(env: CFEnv): S3Config | null {
  if (env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY) {
    return {
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION || 'auto',
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    };
  }
  return null;
}

async function ensureD1Schema(env: CFEnv): Promise<void> {
  if (!env.DB) return;
  await env.DB.prepare(
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
  ).run();
  await env.DB.prepare(
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
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS admin_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`
  ).run();
}

async function queryD1Http(
  accountId: string,
  databaseId: string,
  apiToken: string,
  sql: string,
  params: unknown[] = []
): Promise<any[]> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  });
  const data = (await res.json()) as {
    success?: boolean;
    errors?: Array<{ message: string }>;
    result?: Array<{ results?: any[] }>;
  };
  if (!res.ok || !data.success) {
    throw new Error(data?.errors?.[0]?.message || `D1 HTTP ${res.status}`);
  }
  return data.result?.[0]?.results || [];
}

async function getEdgeAdminPasswordHash(env: CFEnv): Promise<string> {
  if (!env.DB) return '';
  try {
    await ensureD1Schema(env);
    const row = await env.DB.prepare("SELECT value FROM admin_settings WHERE key = 'admin_pw_hash'").bind().first<{ value: string }>();
    return row?.value || '';
  } catch {
    return '';
  }
}

async function isEdgeAdmin(request: Request, env: CFEnv): Promise<boolean> {
  const cookies = parseCookies(request);
  const cookieToken = cookies['bcai_admin'] || '';
  const headerToken = request.headers.get('x-admin-token') || '';
  const token = cookieToken || headerToken;
  const secretSeed = env.ACCESS_PASSWORD || env.CF_API_TOKEN || env.GEMINI_API_KEY || 'bcai-edge-secret';
  const expectedToken = await sha256Hex(`bcai-admin:${secretSeed}`);
  if (token && token === expectedToken) return true;

  const rawPw = request.headers.get('x-access-password') || '';
  if (rawPw) {
    let decoded = rawPw;
    try {
      decoded = decodeURIComponent(rawPw);
    } catch {
      decoded = rawPw;
    }
    if (env.ACCESS_PASSWORD && decoded === env.ACCESS_PASSWORD) return true;
    const savedHash = await getEdgeAdminPasswordHash(env);
    if (savedHash && (await sha256Hex(decoded)) === savedHash) return true;
  }
  return false;
}

function getEdgeGitToken(req: Request, env: CFEnv, provider: string): string {
  const headerToken = req.headers.get('x-git-token') || req.headers.get('x-github-token') || '';
  if (headerToken) return headerToken.trim();
  const cookies = parseCookies(req);
  if (provider === 'github' && cookies['aimx_gh_token']) return cookies['aimx_gh_token'].trim();
  if (provider === 'gitlab') return (env.GITLAB_TOKEN || '').trim();
  if (provider === 'gitee') return (env.GITEE_TOKEN || '').trim();
  return (env.GITHUB_TOKEN || '').trim();
}

function formatEdgeMessages(messages: Array<{ role: string; content: string; attachments?: any[] }>) {
  return messages.map((m) => {
    let text = m.content || '';
    const files = (m.attachments || []).filter((a) => a.kind === 'file' && a.textContent);
    if (files.length > 0) {
      text += files
        .map((f) => `\n\n[附带文件: ${f.name}]\n\`\`\`\n${String(f.textContent || '').slice(0, 24000)}\n\`\`\``)
        .join('');
    }
    const images = (m.attachments || []).filter((a) => a.kind === 'image' && a.dataUrl);
    if (images.length > 0 && m.role === 'user') {
      return {
        role: m.role,
        content: [
          { type: 'text', text: text || '请结合附带的图片进行详细分析。' },
          ...images.map((img) => ({ type: 'image_url', image_url: { url: img.dataUrl } })),
        ],
      };
    }
    return { role: m.role, content: text };
  });
}

export async function handleEdgeRequest(request: Request, env: CFEnv): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = request.method.toUpperCase();

  if (pathname === '/api/health') {
    return jsonRes({ ok: true, brand: 'BCAI', runtime: 'edge', timestamp: new Date().toISOString() });
  }

  // Public config discovery
  if (pathname === '/api/config/public' && method === 'GET') {
    const isAdmin = await isEdgeAdmin(request, env);
    const savedHash = await getEdgeAdminPasswordHash(env);
    const openaiModels = (env.OPENAI_MODELS || 'gpt-4o-mini')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    return jsonRes({
      isAdmin,
      hasAdminPassword: Boolean(env.ACCESS_PASSWORD || savedHash),
      usingEnvPassword: Boolean(env.ACCESS_PASSWORD),
      defaultTargetRepoUrl: env.TARGET_REPO_URL || 'https://github.com/757926525/bcai',
      appUrl: getAppUrl(request, env),
      envProviders: {
        workersAi: Boolean(env.AI || (env.CF_ACCOUNT_ID && env.CF_API_TOKEN)),
        gemini: Boolean(env.GEMINI_API_KEY && env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'),
        deepseek: Boolean(env.DEEPSEEK_API_KEY),
        groq: Boolean(env.GROQ_API_KEY),
        openrouter: Boolean(env.OPENROUTER_API_KEY),
        openai: Boolean(env.OPENAI_API_KEY),
        openaiBaseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
        openaiModels,
      },
      d1Bound: Boolean(env.DB || (env.CF_ACCOUNT_ID && env.CF_D1_DATABASE_ID && env.CF_API_TOKEN)),
      bucketBound: Boolean(env.BUCKET || getS3ConfigFromEnv(env)),
      githubOAuthConfigured: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
    });
  }

  // Admin Login / Logout / Password Update
  if (pathname === '/api/auth/admin-login' && method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { password?: string };
    const pw = body.password || '';
    const savedHash = await getEdgeAdminPasswordHash(env);
    const hasAny = Boolean(env.ACCESS_PASSWORD || savedHash);

    if (hasAny) {
      const okEnv = Boolean(env.ACCESS_PASSWORD && pw === env.ACCESS_PASSWORD);
      const okCustom = Boolean(savedHash && (await sha256Hex(pw)) === savedHash);
      if (!okEnv && !okCustom) {
        return jsonRes({ error: '管理员密码错误' }, 401);
      }
    } else if (pw.trim() && env.DB) {
      await ensureD1Schema(env);
      const h = await sha256Hex(pw.trim());
      await env.DB.prepare("INSERT OR REPLACE INTO admin_settings (key, value, updated_at) VALUES ('admin_pw_hash', ?, ?)")
        .bind(h, new Date().toISOString())
        .run();
    }

    const secretSeed = env.ACCESS_PASSWORD || env.CF_API_TOKEN || env.GEMINI_API_KEY || 'bcai-edge-secret';
    const token = await sha256Hex(`bcai-admin:${secretSeed}`);
    return new Response(
      JSON.stringify({ ok: true, isAdmin: true, adminToken: token, hasAdminPassword: Boolean(hasAny || pw.trim()) }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'Set-Cookie': `bcai_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=1209600`,
        },
      }
    );
  }

  if (pathname === '/api/auth/admin-logout' && method === 'POST') {
    return new Response(JSON.stringify({ ok: true, isAdmin: false }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'Set-Cookie': 'bcai_admin=; Path=/; Max-Age=0; Secure; SameSite=None',
      },
    });
  }

  if (pathname === '/api/auth/admin-password' && method === 'POST') {
    if (!(await isEdgeAdmin(request, env))) return jsonRes({ error: '仅限管理员操作' }, 401);
    const body = (await request.json().catch(() => ({}))) as { newPassword?: string; clearCustomPassword?: boolean };
    if (!env.DB) return jsonRes({ error: 'Edge 模式下修改动态密码需绑定 D1 (DB)，或直接在环境变量修改 ACCESS_PASSWORD' }, 400);
    await ensureD1Schema(env);
    if (body.clearCustomPassword) {
      await env.DB.prepare("DELETE FROM admin_settings WHERE key = 'admin_pw_hash'").bind().run();
      return jsonRes({ ok: true, message: '已清除自定义密码' });
    }
    const trimmed = (body.newPassword || '').trim();
    if (trimmed.length < 4) return jsonRes({ error: '密码至少 4 位字符' }, 400);
    const h = await sha256Hex(trimmed);
    await env.DB.prepare("INSERT OR REPLACE INTO admin_settings (key, value, updated_at) VALUES ('admin_pw_hash', ?, ?)")
      .bind(h, new Date().toISOString())
      .run();
    return jsonRes({ ok: true, message: '管理员密码已保存至 D1' });
  }

  // Provider live probe
  if (pathname === '/api/providers/probe' && method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as {
      providerType: string;
      source?: 'env' | 'custom';
      baseUrl?: string;
      apiKey?: string;
      accountId?: string;
      modelId?: string;
    };
    const start = Date.now();
    try {
      if (body.providerType === 'workers-ai') {
        if (env.AI && body.source !== 'custom') {
          return jsonRes({ status: 'connected', latencyMs: Date.now() - start, message: 'Cloudflare Pages env.AI 原生绑定已就绪' });
        }
        const acc = body.accountId || env.CF_ACCOUNT_ID || '';
        const tok = body.apiKey || env.CF_API_TOKEN || '';
        if (!acc || !tok) return jsonRes({ status: 'unconfigured', message: '未检测到 env.AI 或 CF_ACCOUNT_ID/CF_API_TOKEN' });
        const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(acc)}/ai/models/search?per_page=1`, {
          headers: { authorization: `Bearer ${tok}` },
        });
        if (!r.ok) return jsonRes({ status: 'error', latencyMs: Date.now() - start, message: `HTTP ${r.status}` });
        return jsonRes({ status: 'connected', latencyMs: Date.now() - start, message: 'Workers AI 连通正常' });
      }

      if (body.providerType === 'gemini') {
        const key = (body.source === 'custom' && body.apiKey) || env.GEMINI_API_KEY || '';
        if (!key || key === 'MY_GEMINI_API_KEY') return jsonRes({ status: 'unconfigured', message: '未配置 GEMINI_API_KEY' });
        const probeModel = body.modelId || 'gemini-3.1-flash-lite';
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(probeModel)}?key=${encodeURIComponent(key)}`
        );
        if (!r.ok) return jsonRes({ status: 'error', latencyMs: Date.now() - start, message: `Gemini HTTP ${r.status}` });
        return jsonRes({ status: 'connected', latencyMs: Date.now() - start, message: `已连通 (${probeModel})` });
      }

      let targetBase = body.baseUrl || '';
      let token = body.apiKey || '';
      if (body.source !== 'custom') {
        if (body.providerType === 'deepseek') {
          targetBase = targetBase || env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
          token = env.DEEPSEEK_API_KEY || '';
        } else if (body.providerType === 'groq') {
          targetBase = targetBase || env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
          token = env.GROQ_API_KEY || '';
        } else if (body.providerType === 'openrouter') {
          targetBase = targetBase || 'https://openrouter.ai/api/v1';
          token = env.OPENROUTER_API_KEY || '';
        } else {
          targetBase = targetBase || env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
          token = env.OPENAI_API_KEY || '';
        }
      }

      if (!token) return jsonRes({ status: 'unconfigured', message: '未配置 API Key' });
      const cleanBase = targetBase.replace(/\/+$/, '');
      const modelsUrl = cleanBase.endsWith('/models') ? cleanBase : `${cleanBase}/models`;
      const r = await fetch(modelsUrl, { headers: { authorization: `Bearer ${token}` } });
      if (!r.ok) return jsonRes({ status: 'error', latencyMs: Date.now() - start, message: `HTTP ${r.status}` });
      return jsonRes({ status: 'connected', latencyMs: Date.now() - start, message: '接口连通正常' });
    } catch (err: any) {
      return jsonRes({ status: 'error', latencyMs: Date.now() - start, message: err?.message || '探测失败' });
    }
  }

  // Multimodal Chat SSE
  if (pathname === '/api/chat' && method === 'POST') {
    const body = (await request.json()) as {
      model: string;
      messages: Array<{ role: string; content: string; attachments?: any[] }>;
      temperature?: number;
      providerType?: string;
      source?: 'env' | 'custom';
      baseUrl?: string;
      apiKey?: string;
      accountId?: string;
    };
    const { model, messages, temperature = 0.7, providerType = 'workers-ai', source = 'env', baseUrl, apiKey, accountId } = body;

    if (providerType === 'workers-ai' || model.startsWith('@cf/')) {
      const formatted = formatEdgeMessages(messages);
      if (env.AI && source !== 'custom') {
        const stream = (await env.AI.run(model, { messages: formatted, temperature, stream: true })) as ReadableStream;
        return new Response(stream, {
          headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
        });
      }
      const acc = accountId || env.CF_ACCOUNT_ID || '';
      const tok = apiKey || env.CF_API_TOKEN || '';
      if (!acc || !tok) {
        return jsonRes({ error: '未绑定 Cloudflare Workers AI (env.AI) 或 CF_ACCOUNT_ID/CF_API_TOKEN。' }, 400);
      }
      const upstream = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(acc)}/ai/run/${model}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: formatted, temperature, stream: true }),
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { 'content-type': upstream.headers.get('content-type') || 'text/event-stream; charset=utf-8' },
      });
    }

    if (providerType === 'gemini') {
      const key = (source === 'custom' && apiKey) || env.GEMINI_API_KEY || '';
      if (!key) return jsonRes({ error: '未配置 GEMINI_API_KEY' }, 400);
      const sys = messages.find((m) => m.role === 'system')?.content;
      const contents = messages
        .filter((m) => m.role !== 'system')
        .map((m) => {
          const parts: any[] = [];
          let text = m.content || '';
          const files = (m.attachments || []).filter((a) => a.kind === 'file' && a.textContent);
          if (files.length > 0) {
            text += files.map((f) => `\n\n[附带文件: ${f.name}]\n\`\`\`\n${String(f.textContent || '').slice(0, 24000)}\n\`\`\``).join('');
          }
          if (text) parts.push({ text });
          const imgs = (m.attachments || []).filter((a) => a.kind === 'image' && a.dataUrl);
          for (const img of imgs) {
            const match = String(img.dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
            if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
          }
          if (parts.length === 0) parts.push({ text: '' });
          return { role: m.role === 'assistant' ? 'model' : 'user', parts };
        });

      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;
      const upstream = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents,
          ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}),
        }),
      });
      if (!upstream.ok || !upstream.body) {
        return jsonRes({ error: (await upstream.text()) || 'Gemini 请求失败' }, upstream.status);
      }
      const transform = new TransformStream();
      const writer = transform.writable.getWriter();
      const encoder = new TextEncoder();
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      (async () => {
        let buf = '';
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            for (const ln of lines) {
              if (!ln.startsWith('data:')) continue;
              const raw = ln.slice(5).trim();
              if (!raw) continue;
              try {
                const parsed = JSON.parse(raw);
                const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || '';
                if (text) await writer.write(encoder.encode(`data: ${JSON.stringify({ response: text })}\n\n`));
              } catch {
                // ignore
              }
            }
          }
          await writer.write(encoder.encode('data: [DONE]\n\n'));
        } finally {
          await writer.close();
        }
      })();
      return new Response(transform.readable, {
        headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
      });
    }

    let targetUrl = baseUrl || '';
    let token = apiKey || '';
    if (!token && source === 'env') {
      if (providerType === 'deepseek') {
        targetUrl = targetUrl || env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
        token = env.DEEPSEEK_API_KEY || '';
      } else if (providerType === 'groq') {
        targetUrl = targetUrl || env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
        token = env.GROQ_API_KEY || '';
      } else if (providerType === 'openrouter') {
        targetUrl = targetUrl || 'https://openrouter.ai/api/v1';
        token = env.OPENROUTER_API_KEY || '';
      } else {
        targetUrl = targetUrl || env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
        token = env.OPENAI_API_KEY || '';
      }
    }
    if (!token) return jsonRes({ error: `未配置 ${providerType} 的 API Key` }, 400);
    const formatted = formatEdgeMessages(messages);
    const cleanBase = targetUrl.replace(/\/+$/, '');
    const chatUrl = cleanBase.endsWith('/chat/completions') ? cleanBase : `${cleanBase}/chat/completions`;
    const upstream = await fetch(chatUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: formatted, temperature, stream: true }),
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') || 'text/event-stream; charset=utf-8' },
    });
  }

  // Image Generation with Negative Prompt, CFG Guidance & Seed
  if (pathname === '/api/image' && method === 'POST') {
    const body = (await request.json()) as {
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
    const model = body.model || '@cf/black-forest-labs/flux-1-schnell';
    let finalPrompt = body.prompt;
    let finalNegative = (body.negativePrompt || '').trim();
    if (body.translate && env.AI) {
      if (/[\u4e00-\u9fff]/.test(finalPrompt)) {
        try {
          const tr = (await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
            messages: [
              { role: 'system', content: 'Translate this image prompt into concise vivid English. Output ONLY the prompt.' },
              { role: 'user', content: finalPrompt },
            ],
          })) as { response?: string };
          if (tr?.response) finalPrompt = tr.response.trim();
        } catch {
          // ignore
        }
      }
      if (finalNegative && /[\u4e00-\u9fff]/.test(finalNegative)) {
        try {
          const trNeg = (await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
            messages: [
              { role: 'system', content: 'Translate these negative prompt tags into concise comma-separated English tags. Output ONLY the tags.' },
              { role: 'user', content: finalNegative },
            ],
          })) as { response?: string };
          if (trNeg?.response) finalNegative = trNeg.response.trim();
        } catch {
          // ignore
        }
      }
    }
    const input: Record<string, unknown> = { prompt: finalPrompt, num_steps: body.steps || 4 };
    if (!model.includes('flux')) {
      input.width = body.width || 1024;
      input.height = body.height || 1024;
      if (finalNegative) input.negative_prompt = finalNegative;
      if (typeof body.guidance === 'number' && !Number.isNaN(body.guidance)) input.guidance = body.guidance;
    }
    if (body.seed !== undefined && String(body.seed).trim() !== '' && !Number.isNaN(Number(body.seed))) {
      input.seed = Number(body.seed);
    }

    if (env.AI && !body.apiKey) {
      const out = await env.AI.run(model, input);
      if (out && typeof out === 'object' && 'image' in (out as Record<string, unknown>)) {
        const b64 = (out as { image: string }).image;
        const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        return new Response(bin, {
          headers: { 'content-type': 'image/png', 'x-final-prompt': encodeURIComponent(finalPrompt) },
        });
      }
      return new Response(out as BodyInit, {
        headers: { 'content-type': 'image/png', 'x-final-prompt': encodeURIComponent(finalPrompt) },
      });
    }
    const acc = body.accountId || env.CF_ACCOUNT_ID || '';
    const tok = body.apiKey || env.CF_API_TOKEN || '';
    if (!acc || !tok) {
      return jsonRes({ error: '未绑定 Cloudflare Workers AI (env.AI) 或 CF_ACCOUNT_ID/CF_API_TOKEN' }, 400);
    }
    const upstream = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(acc)}/ai/run/${model}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!upstream.ok) return jsonRes({ error: await upstream.text() }, upstream.status);
    return new Response(upstream.body, {
      headers: {
        'content-type': upstream.headers.get('content-type') || 'image/png',
        'x-final-prompt': encodeURIComponent(finalPrompt),
      },
    });
  }

  // Admin Guard for D1 / Bucket / Sync / Git / Connectors
  const needsAdmin =
    pathname.startsWith('/api/db/') ||
    pathname.startsWith('/api/bucket/') ||
    pathname.startsWith('/api/sync/') ||
    pathname.startsWith('/api/git/') ||
    pathname.startsWith('/api/connectors');

  if (needsAdmin && !(await isEdgeAdmin(request, env))) {
    return jsonRes({ error: '仅限管理员操作，请先在右上角点击“管理员登录”。' }, 401);
  }

  // Database Status / Items
  if (pathname === '/api/db/status' && method === 'GET') {
    if (env.DB) {
      try {
        await ensureD1Schema(env);
        const row = await env.DB.prepare('SELECT COUNT(*) as cnt FROM media_assets').bind().first<{ cnt: number }>();
        return jsonRes({
          mode: 'cloudflare-d1-binding',
          connected: true,
          d1Bound: true,
          label: 'Cloudflare D1 原生绑定 (env.DB)',
          itemCount: Number(row?.cnt || 0),
        });
      } catch (err: any) {
        return jsonRes({ mode: 'cloudflare-d1-binding', connected: false, d1Bound: true, label: err?.message });
      }
    }
    if (env.CF_ACCOUNT_ID && env.CF_D1_DATABASE_ID && env.CF_API_TOKEN) {
      try {
        const rows = await queryD1Http(env.CF_ACCOUNT_ID, env.CF_D1_DATABASE_ID, env.CF_API_TOKEN, 'SELECT COUNT(*) as cnt FROM media_assets');
        return jsonRes({
          mode: 'cloudflare-d1-http',
          connected: true,
          d1Bound: true,
          label: 'Cloudflare D1 HTTP 已连通',
          itemCount: Number(rows?.[0]?.cnt || 0),
        });
      } catch (err: any) {
        return jsonRes({ mode: 'cloudflare-d1-http', connected: false, d1Bound: true, label: err?.message });
      }
    }
    return jsonRes({ mode: 'unconfigured', connected: false, d1Bound: false, label: '未绑定 D1 (env.DB)', itemCount: 0 });
  }

  if (pathname === '/api/db/items' && method === 'GET') {
    const typeFilter = url.searchParams.get('type') || '';
    if (env.DB) {
      await ensureD1Schema(env);
      const stmt = typeFilter
        ? env.DB.prepare('SELECT * FROM media_assets WHERE type = ? ORDER BY updated_at DESC LIMIT 100').bind(typeFilter)
        : env.DB.prepare('SELECT * FROM media_assets ORDER BY updated_at DESC LIMIT 100').bind();
      const { results } = await stmt.all();
      return jsonRes({ mode: 'cloudflare-d1-binding', items: results });
    }
    return jsonRes({ mode: 'unconfigured', items: [] });
  }

  if (pathname === '/api/db/items' && method === 'POST') {
    const item = (await request.json()) as any;
    const now = new Date().toISOString();
    const id = item.id || `asset_${Date.now()}`;
    const contentData = item.contentData || '';
    const sizeBytes = item.sizeBytes ?? new TextEncoder().encode(contentData).length;
    if (env.DB) {
      await ensureD1Schema(env);
      await env.DB.prepare(
        `INSERT OR REPLACE INTO media_assets
         (id, type, name, mime_type, size_bytes, prompt, model_id, content_data, repo_path, storage_location, bucket_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          id,
          item.type || 'file',
          item.name || `asset-${Date.now()}`,
          item.mimeType || 'text/plain',
          sizeBytes,
          item.prompt || '',
          item.modelId || '',
          contentData,
          item.repoPath || '',
          item.storageLocation || 'd1',
          item.bucketKey || '',
          now,
          now
        )
        .run();
      return jsonRes({ ok: true, id, storageLocation: item.storageLocation || 'd1', updatedAt: now });
    }
    return jsonRes({ error: '未绑定 Cloudflare D1 (env.DB)' }, 400);
  }

  if (pathname.startsWith('/api/db/items/') && method === 'DELETE') {
    const id = decodeURIComponent(pathname.slice('/api/db/items/'.length));
    if (!env.DB) return jsonRes({ error: '未绑定 Cloudflare D1 (env.DB)' }, 400);
    await ensureD1Schema(env);
    await env.DB.prepare('DELETE FROM media_assets WHERE id = ?').bind(id).run();
    return jsonRes({ ok: true });
  }

  // Storage Bucket (Native R2 env.BUCKET or S3 HTTP)
  if (pathname === '/api/bucket/status' && method === 'GET') {
    if (env.BUCKET) {
      try {
        const listed = await env.BUCKET.list({ limit: 100 });
        return jsonRes({
          configured: true,
          connected: true,
          mode: 'cf-r2-binding',
          bucketName: 'env.BUCKET (R2)',
          itemCount: listed.objects.length,
          label: 'Cloudflare R2 原生绑定已连通',
        });
      } catch (err: any) {
        return jsonRes({ configured: true, connected: false, mode: 'error', label: err?.message });
      }
    }
    const s3 = getS3ConfigFromEnv(env);
    if (s3) {
      try {
        const objs = await s3ListObjects(s3);
        return jsonRes({
          configured: true,
          connected: true,
          mode: 's3-http',
          bucketName: s3.bucket,
          itemCount: objs.length,
          label: `S3/R2 存储桶已连通 (${s3.bucket})`,
        });
      } catch (err: any) {
        return jsonRes({ configured: true, connected: false, mode: 'error', label: err?.message });
      }
    }
    return jsonRes({ configured: false, connected: false, mode: 'unconfigured', label: '未绑定存储桶 (env.BUCKET / S3)' });
  }

  if (pathname === '/api/bucket/items' && method === 'GET') {
    if (env.BUCKET) {
      const listed = await env.BUCKET.list({ limit: 100 });
      return jsonRes({
        configured: true,
        items: listed.objects.map((o) => ({ key: o.key, size: o.size, lastModified: o.uploaded.toISOString() })),
      });
    }
    const s3 = getS3ConfigFromEnv(env);
    if (s3) return jsonRes({ configured: true, items: await s3ListObjects(s3), bucketName: s3.bucket });
    return jsonRes({ configured: false, items: [] });
  }

  if (pathname === '/api/bucket/upload' && method === 'POST') {
    const body = (await request.json()) as { name: string; mimeType?: string; contentData: string; type?: 'image' | 'file' };
    const safeName = (body.name || 'file').replace(/[^\w.\-\u4e00-\u9fff]/g, '_');
    const key = `bcai-assets/${Date.now()}-${safeName}`;
    const b64Match = body.contentData.match(/^data:([^;]+);base64,(.+)$/);
    const bytes = b64Match
      ? Uint8Array.from(atob(b64Match[2]), (c) => c.charCodeAt(0))
      : new TextEncoder().encode(body.contentData);
    if (env.BUCKET) {
      await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: body.mimeType || 'application/octet-stream' } });
    } else {
      const s3 = getS3ConfigFromEnv(env);
      if (!s3) return jsonRes({ error: '未绑定对象存储桶' }, 400);
      await s3PutObject(s3, key, bytes, body.mimeType || 'application/octet-stream');
    }
    return jsonRes({ ok: true, key, storageLocation: 'bucket' });
  }

  if (pathname === '/api/bucket/download' && method === 'GET') {
    const key = url.searchParams.get('key') || '';
    if (!key) return jsonRes({ error: '缺少 key' }, 400);
    if (env.BUCKET) {
      const obj = await env.BUCKET.get(key);
      if (!obj) return jsonRes({ error: '对象不存在' }, 404);
      return new Response(await obj.arrayBuffer(), {
        headers: { 'content-type': obj.httpMetadata?.contentType || 'application/octet-stream' },
      });
    }
    const s3 = getS3ConfigFromEnv(env);
    if (!s3) return jsonRes({ error: '未绑定对象存储桶' }, 400);
    const obj = await s3GetObject(s3, key);
    const copy = new Uint8Array(obj.bytes.byteLength);
    copy.set(obj.bytes);
    return new Response(copy.buffer, { headers: { 'content-type': obj.contentType } });
  }

  if (pathname === '/api/bucket/items' && method === 'DELETE') {
    const key = url.searchParams.get('key') || '';
    if (!key) return jsonRes({ error: '缺少 key' }, 400);
    if (env.BUCKET) {
      await env.BUCKET.delete(key);
      return jsonRes({ ok: true });
    }
    const s3 = getS3ConfigFromEnv(env);
    if (!s3) return jsonRes({ error: '未绑定对象存储桶' }, 400);
    await s3DeleteObject(s3, key);
    return jsonRes({ ok: true });
  }

  // Conversation Sync
  if (pathname === '/api/sync/conversations' && method === 'POST') {
    const { conversations = [] } = (await request.json()) as { conversations?: any[] };
    const now = new Date().toISOString();
    let d1Ok = false;
    let bucketOk = false;
    const errors: string[] = [];

    if (env.DB) {
      try {
        await ensureD1Schema(env);
        for (const c of conversations.slice(0, 80)) {
          await env.DB.prepare(
            `INSERT OR REPLACE INTO conversations
             (id, title, mode, model_id, provider_id, repo_full_name, repo_branch, status, messages_json, storage_location, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'd1', ?, ?)`
          )
            .bind(
              c.id,
              c.title || '未命名',
              c.mode || 'chat',
              c.modelId || '',
              c.providerId || '',
              c.repoFullName || '',
              c.repoBranch || '',
              c.status || 'active',
              JSON.stringify(c.messages || []),
              c.createdAt || now,
              c.updatedAt || now
            )
            .run();
        }
        d1Ok = true;
      } catch (e: any) {
        errors.push(e?.message || 'D1 同步失败');
      }
    }

    const s3 = getS3ConfigFromEnv(env);
    if (env.BUCKET) {
      try {
        await env.BUCKET.put('bcai-sync/conversations.json', JSON.stringify({ syncedAt: now, conversations }, null, 2));
        bucketOk = true;
      } catch (e: any) {
        errors.push(e?.message || 'R2 同步失败');
      }
    } else if (s3) {
      try {
        await s3PutObject(s3, 'bcai-sync/conversations.json', JSON.stringify({ syncedAt: now, conversations }, null, 2), 'application/json');
        bucketOk = true;
      } catch (e: any) {
        errors.push(e?.message || 'S3 同步失败');
      }
    }

    const ok = d1Ok || bucketOk;
    if (!ok && errors.length === 0) {
      return jsonRes({ ok: false, error: '未绑定 D1 或存储桶' }, 400);
    }
    return jsonRes({ ok, syncedAt: now, count: conversations.length, targets: { d1: d1Ok, bucket: bucketOk }, errors }, ok ? 200 : 500);
  }

  if (pathname === '/api/sync/conversations' && method === 'GET') {
    if (env.DB) {
      await ensureD1Schema(env);
      const { results } = await env.DB.prepare('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 80').bind().all<any>();
      return jsonRes({
        ok: true,
        source: 'd1',
        conversations: results.map((r) => ({
          id: r.id,
          title: r.title,
          mode: r.mode,
          modelId: r.model_id,
          providerId: r.provider_id,
          repoFullName: r.repo_full_name,
          repoBranch: r.repo_branch,
          status: r.status,
          messages: r.messages_json ? JSON.parse(r.messages_json) : [],
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        })),
      });
    }
    if (env.BUCKET) {
      const obj = await env.BUCKET.get('bcai-sync/conversations.json');
      if (!obj) return jsonRes({ error: '存储桶尚无同步记录' }, 404);
      const parsed = JSON.parse(await obj.text());
      return jsonRes({ ok: true, source: 'bucket', conversations: parsed.conversations || [] });
    }
    return jsonRes({ error: '未绑定 D1 或存储桶' }, 400);
  }

  // GitHub OAuth & Multi-Git basic routes
  if (pathname === '/api/auth/github/url' && method === 'GET') {
    if (!env.GITHUB_CLIENT_ID) {
      return jsonRes({ error: '未配置 GITHUB_CLIENT_ID，请使用 Token 连接。' }, 400);
    }
    const redirectUri = `${getAppUrl(request, env)}/auth/callback`;
    const params = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: redirectUri, scope: 'repo read:user' });
    return jsonRes({ url: `https://github.com/login/oauth/authorize?${params.toString()}`, redirectUri });
  }

  if ((pathname === '/auth/callback' || pathname === '/auth/callback/') && method === 'GET') {
    const code = url.searchParams.get('code');
    if (!code || !env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
      return new Response('Missing code or GitHub OAuth credentials', { status: 400 });
    }
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${getAppUrl(request, env)}/auth/callback`,
      }),
    });
    const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string };
    if (!tokenJson.access_token) return new Response(`GitHub OAuth error: ${tokenJson.error || 'unknown'}`, { status: 400 });
    const userRes = await fetch('https://api.github.com/user', {
      headers: { authorization: `Bearer ${tokenJson.access_token}`, 'user-agent': 'bcai-workbench' },
    });
    const user = await userRes.json();
    const html = `<!doctype html><html><body><script>
      if (window.opener) {
        window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS', provider: 'github', user: ${JSON.stringify(user)}, token: ${JSON.stringify(tokenJson.access_token)} }, '*');
        window.close();
      } else { window.location.href = '/'; }
    </script><p>GitHub 授权成功，正在返回 BCAI 工作台...</p></body></html>`;
    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'Set-Cookie': `aimx_gh_token=${encodeURIComponent(tokenJson.access_token)}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=1209600`,
      },
    });
  }

  if (pathname === '/api/git/connect' && method === 'POST') {
    const { provider = 'github', token = '', hostUrl = 'https://gitlab.com' } = (await request.json().catch(() => ({}))) as any;
    const clean = String(token).trim();
    if (!clean) return jsonRes({ error: '请输入 Token' }, 400);
    if (provider === 'github') {
      const r = await fetch('https://api.github.com/user', { headers: { authorization: `Bearer ${clean}`, 'user-agent': 'bcai-workbench' } });
      if (!r.ok) return jsonRes({ error: `GitHub HTTP ${r.status}` }, 401);
      const user = await r.json();
      return new Response(JSON.stringify({ ok: true, provider, user }), {
        headers: {
          'content-type': 'application/json',
          'Set-Cookie': `aimx_gh_token=${encodeURIComponent(clean)}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=1209600`,
        },
      });
    }
    if (provider === 'gitlab') {
      const r = await fetch(`${hostUrl.replace(/\/+$/, '')}/api/v4/user`, { headers: { 'PRIVATE-TOKEN': clean } });
      if (!r.ok) return jsonRes({ error: `GitLab HTTP ${r.status}` }, 401);
      const gl = (await r.json()) as any;
      return jsonRes({ ok: true, provider, user: { login: gl.username, name: gl.name, avatar_url: gl.avatar_url, provider: 'gitlab' } });
    }
    const r = await fetch(`https://gitee.com/api/v5/user?access_token=${encodeURIComponent(clean)}`);
    if (!r.ok) return jsonRes({ error: `Gitee HTTP ${r.status}` }, 401);
    const ge = (await r.json()) as any;
    return jsonRes({ ok: true, provider, user: { login: ge.login, name: ge.name, avatar_url: ge.avatar_url, provider: 'gitee' } });
  }

  if (pathname === '/api/git/status' && method === 'GET') {
    const provider = url.searchParams.get('provider') || 'github';
    const token = getEdgeGitToken(request, env, provider);
    if (!token) return jsonRes({ connected: false, provider });
    if (provider === 'github') {
      const r = await fetch('https://api.github.com/user', { headers: { authorization: `Bearer ${token}`, 'user-agent': 'bcai-workbench' } });
      if (!r.ok) return jsonRes({ connected: false, provider });
      return jsonRes({ connected: true, provider, user: await r.json() });
    }
    return jsonRes({ connected: true, provider });
  }

  if (pathname === '/api/connectors/probe' && method === 'POST') {
    const { endpoint = '', secretToken = '' } = (await request.json().catch(() => ({}))) as any;
    if (!endpoint) return jsonRes({ status: 'unconfigured', message: '请填写端点 URL' });
    const start = Date.now();
    try {
      const headers: Record<string, string> = {};
      if (secretToken) headers.authorization = `Bearer ${secretToken}`;
      const r = await fetch(endpoint, { headers });
      return jsonRes({ status: r.ok ? 'connected' : 'error', latencyMs: Date.now() - start, message: `HTTP ${r.status}` });
    } catch (e: any) {
      return jsonRes({ status: 'error', latencyMs: Date.now() - start, message: e?.message || '探测失败' });
    }
  }

  return jsonRes({ error: `Not found: ${pathname}` }, 404);
}

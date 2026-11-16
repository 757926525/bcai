import { checkAccess, type CFEnv } from './_types';

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

function getGitHubToken(req: Request, env: CFEnv): string {
  const headerToken = req.headers.get('x-github-token') || '';
  if (headerToken) return headerToken.trim();
  const cookies = parseCookies(req);
  if (cookies['aimx_gh_token']) return cookies['aimx_gh_token'].trim();
  return (env.GITHUB_TOKEN || '').trim();
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
      created_at TEXT NOT NULL,
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

export async function handleEdgeRequest(request: Request, env: CFEnv): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = request.method.toUpperCase();

  // Health
  if (pathname === '/api/health') {
    return jsonRes({ ok: true, runtime: 'edge', timestamp: new Date().toISOString() });
  }

  // Public config discovery
  if (pathname === '/api/config/public' && method === 'GET') {
    const cookies = parseCookies(request);
    const expectedPw = env.ACCESS_PASSWORD || '';
    const unlocked = !expectedPw || cookies['aimx_access'] === expectedPw;
    const openaiModels = (env.OPENAI_MODELS || 'gpt-4o-mini')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    return jsonRes({
      requiresPassword: Boolean(expectedPw),
      unlocked,
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
      githubOAuthConfigured: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
    });
  }

  // Auth login/logout
  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { password?: string; plan?: string };
    const expected = env.ACCESS_PASSWORD || '';
    if (expected && body.password !== expected) {
      return jsonRes({ error: '访问密码错误' }, 401);
    }
    const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' });
    if (expected) {
      headers.append(
        'Set-Cookie',
        `aimx_access=${encodeURIComponent(expected)}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=604800`
      );
    }
    return new Response(JSON.stringify({ ok: true, unlocked: true, plan: body.plan || 'free' }), {
      status: 200,
      headers,
    });
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'Set-Cookie': 'aimx_access=; Path=/; Max-Age=0; Secure; SameSite=None',
      },
    });
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
          return jsonRes({
            status: 'connected',
            latencyMs: Date.now() - start,
            message: 'Cloudflare Pages env.AI 原生绑定已就绪',
          });
        }
        const acc = body.accountId || env.CF_ACCOUNT_ID || '';
        const tok = body.apiKey || env.CF_API_TOKEN || '';
        if (!acc || !tok) {
          return jsonRes({ status: 'unconfigured', message: '未检测到 env.AI 或 CF_ACCOUNT_ID/CF_API_TOKEN' });
        }
        const r = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(acc)}/ai/models/search?per_page=1`,
          { headers: { authorization: `Bearer ${tok}` } }
        );
        if (!r.ok) {
          return jsonRes({ status: 'error', latencyMs: Date.now() - start, message: `HTTP ${r.status}` });
        }
        return jsonRes({ status: 'connected', latencyMs: Date.now() - start, message: 'Workers AI 连通正常' });
      }

      if (body.providerType === 'gemini') {
        const key = (body.source === 'custom' && body.apiKey) || env.GEMINI_API_KEY || '';
        if (!key || key === 'MY_GEMINI_API_KEY') {
          return jsonRes({ status: 'unconfigured', message: '未配置 GEMINI_API_KEY' });
        }
        const probeModel = body.modelId || 'gemini-3.1-flash-lite';
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(probeModel)}?key=${encodeURIComponent(key)}`
        );
        if (!r.ok) {
          return jsonRes({ status: 'error', latencyMs: Date.now() - start, message: `Gemini HTTP ${r.status}` });
        }
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
      if (!r.ok) {
        return jsonRes({ status: 'error', latencyMs: Date.now() - start, message: `HTTP ${r.status}` });
      }
      return jsonRes({ status: 'connected', latencyMs: Date.now() - start, message: '接口连通正常' });
    } catch (err: any) {
      return jsonRes({ status: 'error', latencyMs: Date.now() - start, message: err?.message || '探测失败' });
    }
  }

  // Chat SSE
  if (pathname === '/api/chat' && method === 'POST') {
    const denied = checkAccess(request, env);
    if (denied) return denied;
    const body = (await request.json()) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      temperature?: number;
      providerType?: string;
      source?: 'env' | 'custom';
      baseUrl?: string;
      apiKey?: string;
      accountId?: string;
    };
    const { model, messages, temperature = 0.7, providerType = 'workers-ai', source = 'env', baseUrl, apiKey, accountId } = body;

    if (providerType === 'workers-ai' || model.startsWith('@cf/')) {
      if (env.AI && source !== 'custom') {
        const stream = (await env.AI.run(model, { messages, temperature, stream: true })) as ReadableStream;
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
        body: JSON.stringify({ messages, temperature, stream: true }),
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
        .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
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
    const cleanBase = targetUrl.replace(/\/+$/, '');
    const chatUrl = cleanBase.endsWith('/chat/completions') ? cleanBase : `${cleanBase}/chat/completions`;
    const upstream = await fetch(chatUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, temperature, stream: true }),
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') || 'text/event-stream; charset=utf-8' },
    });
  }

  // Image Generation
  if (pathname === '/api/image' && method === 'POST') {
    const denied = checkAccess(request, env);
    if (denied) return denied;
    const body = (await request.json()) as {
      prompt: string;
      model?: string;
      steps?: number;
      width?: number;
      height?: number;
      translate?: boolean;
      accountId?: string;
      apiKey?: string;
    };
    const model = body.model || '@cf/black-forest-labs/flux-1-schnell';
    let finalPrompt = body.prompt;
    const hasCjk = /[\u4e00-\u9fff]/.test(finalPrompt);
    if (body.translate && hasCjk && env.AI) {
      try {
        const tr = (await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
          messages: [
            { role: 'system', content: 'Translate this image prompt into concise vivid English. Output ONLY the prompt.' },
            { role: 'user', content: finalPrompt },
          ],
        })) as { response?: string };
        if (tr?.response) finalPrompt = tr.response.trim();
      } catch {
        // keep original
      }
    }
    const input: Record<string, unknown> = { prompt: finalPrompt, num_steps: body.steps || 4 };
    if (!model.includes('flux')) {
      input.width = body.width || 1024;
      input.height = body.height || 1024;
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

  // Database routes (D1 Native Binding or D1 HTTP)
  if (pathname === '/api/db/status' && method === 'GET') {
    const denied = checkAccess(request, env);
    if (denied) return denied;
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
        return jsonRes({
          mode: 'cloudflare-d1-binding',
          connected: false,
          d1Bound: true,
          label: `D1 初始化异常: ${err?.message}`,
        });
      }
    }
    if (env.CF_ACCOUNT_ID && env.CF_D1_DATABASE_ID && env.CF_API_TOKEN) {
      try {
        const rows = await queryD1Http(env.CF_ACCOUNT_ID, env.CF_D1_DATABASE_ID, env.CF_API_TOKEN, 'SELECT COUNT(*) as cnt FROM media_assets');
        return jsonRes({
          mode: 'cloudflare-d1-http',
          connected: true,
          d1Bound: true,
          label: 'Cloudflare D1 环境变量已连通',
          itemCount: Number(rows?.[0]?.cnt || 0),
        });
      } catch (err: any) {
        return jsonRes({ mode: 'cloudflare-d1-http', connected: false, d1Bound: true, label: err?.message });
      }
    }
    return jsonRes({
      mode: 'unconfigured',
      connected: false,
      d1Bound: false,
      label: '请在 Pages Settings -> Functions 绑定 D1 变量 DB，或填写 D1 HTTP 凭证',
      itemCount: 0,
    });
  }

  if (pathname === '/api/db/items' && method === 'GET') {
    const denied = checkAccess(request, env);
    if (denied) return denied;
    const typeFilter = url.searchParams.get('type') || '';
    if (env.DB) {
      await ensureD1Schema(env);
      const stmt = typeFilter
        ? env.DB.prepare('SELECT * FROM media_assets WHERE type = ? ORDER BY updated_at DESC LIMIT 100').bind(typeFilter)
        : env.DB.prepare('SELECT * FROM media_assets ORDER BY updated_at DESC LIMIT 100').bind();
      const { results } = await stmt.all();
      return jsonRes({ mode: 'cloudflare-d1-binding', items: results });
    }
    if (env.CF_ACCOUNT_ID && env.CF_D1_DATABASE_ID && env.CF_API_TOKEN) {
      const rows = typeFilter
        ? await queryD1Http(env.CF_ACCOUNT_ID, env.CF_D1_DATABASE_ID, env.CF_API_TOKEN, 'SELECT * FROM media_assets WHERE type = ? ORDER BY updated_at DESC LIMIT 100', [typeFilter])
        : await queryD1Http(env.CF_ACCOUNT_ID, env.CF_D1_DATABASE_ID, env.CF_API_TOKEN, 'SELECT * FROM media_assets ORDER BY updated_at DESC LIMIT 100');
      return jsonRes({ mode: 'cloudflare-d1-http', items: rows });
    }
    return jsonRes({ mode: 'unconfigured', items: [] });
  }

  if (pathname === '/api/db/items' && method === 'POST') {
    const denied = checkAccess(request, env);
    if (denied) return denied;
    const item = (await request.json()) as {
      id?: string;
      type?: 'image' | 'file';
      name?: string;
      mimeType?: string;
      sizeBytes?: number;
      prompt?: string;
      modelId?: string;
      contentData?: string;
      repoPath?: string;
    };
    const now = new Date().toISOString();
    const id = item.id || `asset_${Date.now()}`;
    const contentData = item.contentData || '';
    const sizeBytes = item.sizeBytes ?? new TextEncoder().encode(contentData).length;

    if (env.DB) {
      await ensureD1Schema(env);
      await env.DB.prepare(
        `INSERT OR REPLACE INTO media_assets
         (id, type, name, mime_type, size_bytes, prompt, model_id, content_data, repo_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          now,
          now
        )
        .run();
      return jsonRes({ ok: true, id, updatedAt: now });
    }
    return jsonRes({ error: '未绑定 Cloudflare D1 (env.DB)' }, 400);
  }

  if (pathname.startsWith('/api/db/items/') && method === 'DELETE') {
    const denied = checkAccess(request, env);
    if (denied) return denied;
    const id = decodeURIComponent(pathname.slice('/api/db/items/'.length));
    if (!env.DB) return jsonRes({ error: '未绑定 Cloudflare D1 (env.DB)' }, 400);
    await ensureD1Schema(env);
    await env.DB.prepare('DELETE FROM media_assets WHERE id = ?').bind(id).run();
    return jsonRes({ ok: true });
  }

  // GitHub OAuth & Repo Proxy
  if (pathname === '/api/auth/github/url' && method === 'GET') {
    if (!env.GITHUB_CLIENT_ID) {
      return jsonRes({ error: '未配置 GITHUB_CLIENT_ID，请使用 PAT Token 或在环境变量设置 GitHub OAuth 应用。' }, 400);
    }
    const redirectUri = `${getAppUrl(request, env)}/auth/callback`;
    const params = new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: 'repo read:user',
    });
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
    if (!tokenJson.access_token) {
      return new Response(`GitHub OAuth error: ${tokenJson.error || 'unknown'}`, { status: 400 });
    }
    const userRes = await fetch('https://api.github.com/user', {
      headers: { authorization: `Bearer ${tokenJson.access_token}`, 'user-agent': 'aimx-workbench' },
    });
    const user = await userRes.json();
    const html = `<!doctype html><html><body><script>
      if (window.opener) {
        window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS', provider: 'github', user: ${JSON.stringify(user)}, token: ${JSON.stringify(tokenJson.access_token)} }, '*');
        window.close();
      } else { window.location.href = '/'; }
    </script><p>GitHub 授权成功，正在返回...</p></body></html>`;
    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'Set-Cookie': `aimx_gh_token=${encodeURIComponent(tokenJson.access_token)}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=1209600`,
      },
    });
  }

  if (pathname === '/api/github/token' && method === 'POST') {
    const { token } = (await request.json().catch(() => ({}))) as { token?: string };
    if (!token) return jsonRes({ error: '请输入 GitHub Personal Access Token' }, 400);
    const r = await fetch('https://api.github.com/user', {
      headers: { authorization: `Bearer ${token.trim()}`, 'user-agent': 'aimx-workbench' },
    });
    if (!r.ok) return jsonRes({ error: `GitHub 验证失败 (HTTP ${r.status})` }, 401);
    const user = await r.json();
    return new Response(JSON.stringify({ ok: true, user }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'Set-Cookie': `aimx_gh_token=${encodeURIComponent(token.trim())}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=1209600`,
      },
    });
  }

  if (pathname === '/api/github/disconnect' && method === 'POST') {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'Set-Cookie': 'aimx_gh_token=; Path=/; Max-Age=0; Secure; SameSite=None',
      },
    });
  }

  if (pathname === '/api/github/status' && method === 'GET') {
    const token = getGitHubToken(request, env);
    if (!token) return jsonRes({ connected: false });
    const r = await fetch('https://api.github.com/user', {
      headers: { authorization: `Bearer ${token}`, 'user-agent': 'aimx-workbench' },
    });
    if (!r.ok) return jsonRes({ connected: false });
    return jsonRes({ connected: true, user: await r.json() });
  }

  if (pathname === '/api/github/repos' && method === 'GET') {
    const token = getGitHubToken(request, env);
    if (!token) return jsonRes({ error: '未连接 GitHub 账号' }, 401);
    const r = await fetch('https://api.github.com/user/repos?sort=updated&per_page=50&affiliation=owner,collaborator,organization_member', {
      headers: { authorization: `Bearer ${token}`, 'user-agent': 'aimx-workbench' },
    });
    const data = await r.json();
    return jsonRes({ repos: Array.isArray(data) ? data : [] }, r.status);
  }

  if (pathname === '/api/github/branches' && method === 'GET') {
    const repo = url.searchParams.get('repo') || '';
    const token = getGitHubToken(request, env);
    if (!repo) return jsonRes({ error: '缺少 repo 参数' }, 400);
    const headers: Record<string, string> = { 'user-agent': 'aimx-workbench' };
    if (token) headers.authorization = `Bearer ${token}`;
    const r = await fetch(`https://api.github.com/repos/${repo}/branches?per_page=100`, { headers });
    const data = await r.json();
    return jsonRes({ branches: Array.isArray(data) ? data : [] }, r.status);
  }

  if (pathname === '/api/github/tree' && method === 'GET') {
    const repo = url.searchParams.get('repo') || '';
    const branch = url.searchParams.get('branch') || 'main';
    const token = getGitHubToken(request, env);
    if (!repo) return jsonRes({ error: '缺少 repo 参数' }, 400);
    const headers: Record<string, string> = { 'user-agent': 'aimx-workbench' };
    if (token) headers.authorization = `Bearer ${token}`;
    const r = await fetch(`https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, { headers });
    const data = (await r.json()) as { tree?: any[]; message?: string };
    if (!r.ok) return jsonRes({ error: data?.message || '读取目录树失败' }, r.status);
    return jsonRes({ tree: data.tree || [] });
  }

  if (pathname === '/api/github/file' && method === 'GET') {
    const repo = url.searchParams.get('repo') || '';
    const filePath = url.searchParams.get('path') || '';
    const branch = url.searchParams.get('branch') || 'main';
    const token = getGitHubToken(request, env);
    if (!repo || !filePath) return jsonRes({ error: '缺少 repo 或 path 参数' }, 400);
    const headers: Record<string, string> = { 'user-agent': 'aimx-workbench' };
    if (token) headers.authorization = `Bearer ${token}`;
    const r = await fetch(
      `https://api.github.com/repos/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`,
      { headers }
    );
    const data = (await r.json()) as { content?: string; sha?: string; size?: number; message?: string };
    if (!r.ok) return jsonRes({ error: data?.message || '读取文件失败' }, r.status);
    const rawB64 = (data.content || '').replace(/\n/g, '');
    const bytes = Uint8Array.from(atob(rawB64), (c) => c.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    return jsonRes({ path: filePath, sha: data.sha, size: data.size, content: decoded });
  }

  if (pathname === '/api/github/branch' && method === 'POST') {
    const { repo, newBranch, fromBranch = 'main' } = (await request.json()) as {
      repo: string;
      newBranch: string;
      fromBranch?: string;
    };
    const token = getGitHubToken(request, env);
    if (!token) return jsonRes({ error: '创建分支需要先授权连接 GitHub' }, 401);
    const refRes = await fetch(`https://api.github.com/repos/${repo}/git/ref/heads/${encodeURIComponent(fromBranch)}`, {
      headers: { authorization: `Bearer ${token}`, 'user-agent': 'aimx-workbench' },
    });
    const refData = (await refRes.json()) as { object?: { sha: string }; message?: string };
    if (!refRes.ok || !refData?.object?.sha) {
      return jsonRes({ error: refData?.message || '获取源分支 SHA 失败' }, refRes.status);
    }
    const createRes = await fetch(`https://api.github.com/repos/${repo}/git/refs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'user-agent': 'aimx-workbench', 'content-type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${newBranch}`, sha: refData.object.sha }),
    });
    const createData = await createRes.json();
    if (!createRes.ok) return jsonRes({ error: (createData as any)?.message || '创建分支失败' }, createRes.status);
    return jsonRes({ ok: true, branch: newBranch, data: createData });
  }

  if (pathname === '/api/github/file' && method === 'PUT') {
    const { repo, path: filePath, content, message, branch = 'main', sha } = (await request.json()) as {
      repo: string;
      path: string;
      content: string;
      message?: string;
      branch?: string;
      sha?: string;
    };
    const token = getGitHubToken(request, env);
    if (!token) return jsonRes({ error: '写入推送文件需要先授权连接 GitHub' }, 401);
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
    const utf8Bytes = new TextEncoder().encode(content);
    let binStr = '';
    for (let i = 0; i < utf8Bytes.length; i++) binStr += String.fromCharCode(utf8Bytes[i]);
    const b64 = btoa(binStr);

    const r = await fetch(`https://api.github.com/repos/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'user-agent': 'aimx-workbench', 'content-type': 'application/json' },
      body: JSON.stringify({
        message: message || `Update ${filePath} via AIMX Workbench`,
        content: b64,
        branch,
        ...(currentSha ? { sha: currentSha } : {}),
      }),
    });
    const data = await r.json();
    if (!r.ok) return jsonRes({ error: (data as any)?.message || '推送提交失败' }, r.status);
    return jsonRes({ ok: true, commit: (data as any)?.commit, content: (data as any)?.content });
  }

  return jsonRes({ error: `Not found: ${pathname}` }, 404);
}

import {
  s3DeleteObject,
  s3GetObject,
  s3ListObjects,
  s3PutObject,
  sha256Hex,
  type S3Config,
} from './_crypto-s3';
import {
  type ExternalDbConfig,
  dbProviderLabel,
  deleteExternalDbAsset,
  fetchExternalDbConversations,
  listExternalDbAssets,
  syncExternalDbConversations,
  testAndInitExternalDb,
  upsertExternalDbAsset,
} from './_db-adapters';
import { type CFEnv } from './_types';

function jsonRes(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

function buildCookie(name: string, value: string, maxAgeSec = 1209600): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${maxAgeSec}`;
}

function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=0`;
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

function getS3ConfigFromEnv(env: CFEnv): S3Config | null {
  if (env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY) {
    return {
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION || 'auto',
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      addressingStyle:
        env.S3_ADDRESSING_STYLE === 'virtual'
          ? 'virtual'
          : env.S3_ADDRESSING_STYLE === 'path'
          ? 'path'
          : undefined,
    };
  }
  return null;
}

function getEdgeExternalDbConfig(env: CFEnv): ExternalDbConfig | null {
  if (env.CF_ACCOUNT_ID && env.CF_D1_DATABASE_ID && env.CF_API_TOKEN) {
    return {
      provider: 'd1-http',
      accountId: env.CF_ACCOUNT_ID,
      databaseId: env.CF_D1_DATABASE_ID,
      apiToken: env.CF_API_TOKEN,
    };
  }
  if (env.TURSO_URL && env.TURSO_AUTH_TOKEN) {
    return {
      provider: 'turso',
      tursoUrl: env.TURSO_URL,
      tursoAuthToken: env.TURSO_AUTH_TOKEN,
    };
  }
  if (env.SUPABASE_URL && env.SUPABASE_KEY) {
    return {
      provider: 'supabase',
      supabaseUrl: env.SUPABASE_URL,
      supabaseKey: env.SUPABASE_KEY,
    };
  }
  if (env.NEON_CONNECTION_STRING) {
    return {
      provider: 'neon',
      neonConnectionString: env.NEON_CONNECTION_STRING,
    };
  }
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    return {
      provider: 'upstash',
      upstashUrl: env.UPSTASH_REDIS_REST_URL,
      upstashToken: env.UPSTASH_REDIS_REST_TOKEN,
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

const EDGE_SETTINGS_OBJECT_KEY = '_system/admin-settings.json';

async function readEdgeSettingsMap(env: CFEnv): Promise<Record<string, string>> {
  if (env.BUCKET) {
    try {
      const obj = await env.BUCKET.get(EDGE_SETTINGS_OBJECT_KEY);
      if (obj) return JSON.parse(await obj.text()) as Record<string, string>;
    } catch {
      // ignore
    }
  }
  const s3 = getS3ConfigFromEnv(env);
  if (s3) {
    try {
      const got = await s3GetObject(s3, EDGE_SETTINGS_OBJECT_KEY);
      if (got) return JSON.parse(new TextDecoder().decode(got.bytes)) as Record<string, string>;
    } catch {
      // ignore
    }
  }
  return {};
}

async function writeEdgeSettingsMap(env: CFEnv, key: string, value: string | null): Promise<boolean> {
  if (env.BUCKET) {
    const map = await readEdgeSettingsMap(env);
    if (value === null) delete map[key];
    else map[key] = value;
    await env.BUCKET.put(EDGE_SETTINGS_OBJECT_KEY, JSON.stringify(map), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    });
    return true;
  }
  const s3 = getS3ConfigFromEnv(env);
  if (s3) {
    const map = await readEdgeSettingsMap(env);
    if (value === null) delete map[key];
    else map[key] = value;
    await s3PutObject(s3, EDGE_SETTINGS_OBJECT_KEY, new TextEncoder().encode(JSON.stringify(map)), 'application/json');
    return true;
  }
  return false;
}

async function getD1Setting(env: CFEnv, key: string): Promise<string> {
  if (env.DB) {
    try {
      await ensureD1Schema(env);
      const row = await env.DB.prepare('SELECT value FROM admin_settings WHERE key = ?')
        .bind(key)
        .first<{ value: string }>();
      if (row?.value) return row.value;
    } catch {
      // fall through
    }
  }
  const map = await readEdgeSettingsMap(env);
  return map[key] || '';
}

async function setD1Setting(env: CFEnv, key: string, value: string): Promise<boolean> {
  if (env.DB) {
    await ensureD1Schema(env);
    await env.DB.prepare('INSERT OR REPLACE INTO admin_settings (key, value, updated_at) VALUES (?, ?, ?)')
      .bind(key, value, new Date().toISOString())
      .run();
    return true;
  }
  return writeEdgeSettingsMap(env, key, value);
}

async function deleteD1Setting(env: CFEnv, key: string): Promise<void> {
  if (env.DB) {
    await ensureD1Schema(env);
    await env.DB.prepare('DELETE FROM admin_settings WHERE key = ?').bind(key).run();
    return;
  }
  await writeEdgeSettingsMap(env, key, null);
}

async function getEdgeAdminPasswordHash(env: CFEnv): Promise<string> {
  return getD1Setting(env, 'admin_pw_hash');
}

async function getEdgeLoginGate(env: CFEnv): Promise<boolean> {
  const v = await getD1Setting(env, 'login_gate');
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  return (env.REQUIRE_LOGIN_GATE || '').toLowerCase() === 'true';
}

function getEdgeSecretSeed(env: CFEnv): string {
  return env.ACCESS_PASSWORD || env.CF_API_TOKEN || env.GEMINI_API_KEY || 'bcai-edge-secret';
}

async function isEdgeAdmin(request: Request, env: CFEnv): Promise<boolean> {
  const cookies = parseCookies(request);
  const cookieToken = cookies['bcai_admin'] || '';
  const headerToken = request.headers.get('x-admin-token') || '';
  const token = cookieToken || headerToken;
  const expectedToken = await sha256Hex(`bcai-admin:${getEdgeSecretSeed(env)}`);
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

async function signEdgeState(payload: Record<string, unknown>, secret: string): Promise<string> {
  const json = JSON.stringify(payload);
  const b64 = btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const sig = await sha256Hex(`${secret}:${b64}`);
  return `${b64}.${sig}`;
}

async function verifyEdgeState(state: string, secret: string): Promise<Record<string, any> | null> {
  const dot = state.indexOf('.');
  if (dot <= 0) return null;
  const b64 = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = await sha256Hex(`${secret}:${b64}`);
  if (sig !== expected) return null;
  try {
    const padded = b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4);
    const json = decodeURIComponent(escape(atob(padded)));
    return JSON.parse(json) as Record<string, any>;
  } catch {
    return null;
  }
}

async function getEdgeGitOAuthConfig(env: CFEnv): Promise<{
  siteId?: string;
  github?: { clientId?: string; clientSecret?: string };
  gitlab?: { clientId?: string; clientSecret?: string; hostUrl?: string };
  gitee?: { clientId?: string; clientSecret?: string };
}> {
  const raw = await getD1Setting(env, 'git_oauth_config');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function resolveEdgeGitOAuthCredentials(
  env: CFEnv,
  provider: 'github' | 'gitlab' | 'gitee',
  hostUrlOverride?: string
): Promise<{ clientId: string; clientSecret: string; hostUrl: string }> {
  const saved = await getEdgeGitOAuthConfig(env);
  if (provider === 'github') {
    return {
      clientId: (env.GITHUB_CLIENT_ID || saved.github?.clientId || '').trim(),
      clientSecret: (env.GITHUB_CLIENT_SECRET || saved.github?.clientSecret || '').trim(),
      hostUrl: 'https://github.com',
    };
  }
  if (provider === 'gitlab') {
    return {
      clientId: (env.GITLAB_CLIENT_ID || saved.gitlab?.clientId || '').trim(),
      clientSecret: (env.GITLAB_CLIENT_SECRET || saved.gitlab?.clientSecret || '').trim(),
      hostUrl: (hostUrlOverride || saved.gitlab?.hostUrl || 'https://gitlab.com').trim().replace(/\/+$/, ''),
    };
  }
  return {
    clientId: (env.GITEE_CLIENT_ID || saved.gitee?.clientId || '').trim(),
    clientSecret: (env.GITEE_CLIENT_SECRET || saved.gitee?.clientSecret || '').trim(),
    hostUrl: 'https://gitee.com',
  };
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
    const requireLoginGate = await getEdgeLoginGate(env);
    const extDb = getEdgeExternalDbConfig(env);
    const ghOAuth = await resolveEdgeGitOAuthCredentials(env, 'github');
    const glOAuth = await resolveEdgeGitOAuthCredentials(env, 'gitlab');
    const geOAuth = await resolveEdgeGitOAuthCredentials(env, 'gitee');
    const openaiModels = (env.OPENAI_MODELS || 'gpt-4o-mini')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    return jsonRes({
      isAdmin,
      hasAdminPassword: Boolean(env.ACCESS_PASSWORD || savedHash),
      usingEnvPassword: Boolean(env.ACCESS_PASSWORD),
      requireLoginGate,
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
      d1Bound: Boolean(env.DB || extDb),
      dbProvider: env.DB ? 'cf-d1-native' : extDb?.provider || 'unconfigured',
      bucketBound: Boolean(env.BUCKET || getS3ConfigFromEnv(env)),
      githubOAuthConfigured: Boolean(ghOAuth.clientId && ghOAuth.clientSecret),
      gitOAuthProviders: {
        github: Boolean(ghOAuth.clientId && ghOAuth.clientSecret),
        gitlab: Boolean(glOAuth.clientId && glOAuth.clientSecret),
        gitee: Boolean(geOAuth.clientId && geOAuth.clientSecret),
      },
    });
  }

  // Admin Login / Logout / Password / Login Gate
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
    } else if (pw.trim()) {
      const h = await sha256Hex(pw.trim());
      await setD1Setting(env, 'admin_pw_hash', h);
    }

    const latestHash = await getEdgeAdminPasswordHash(env);
    const token = await sha256Hex(`bcai-admin:${getEdgeSecretSeed(env)}`);
    return new Response(
      JSON.stringify({ ok: true, isAdmin: true, adminToken: token, hasAdminPassword: Boolean(env.ACCESS_PASSWORD || latestHash) }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'Set-Cookie': buildCookie('bcai_admin', token),
        },
      }
    );
  }

  if (pathname === '/api/auth/admin-logout' && method === 'POST') {
    return new Response(JSON.stringify({ ok: true, isAdmin: false }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'Set-Cookie': clearCookie('bcai_admin'),
      },
    });
  }

  if (pathname === '/api/auth/login-gate' && method === 'POST') {
    if (!(await isEdgeAdmin(request, env))) return jsonRes({ error: '仅限管理员操作' }, 401);
    const body = (await request.json().catch(() => ({}))) as { enabled?: boolean; initialPassword?: string };
    const enabled = Boolean(body.enabled);
    const savedHash = await getEdgeAdminPasswordHash(env);
    const hasPw = Boolean(env.ACCESS_PASSWORD || savedHash);

    if (enabled && !hasPw) {
      const initPw = (body.initialPassword || '').trim();
      if (initPw.length >= 4) {
        const h = await sha256Hex(initPw);
        const saved = await setD1Setting(env, 'admin_pw_hash', h);
        if (!saved) {
          return jsonRes({ error: 'Edge 模式下保存管理员密码需要绑定 D1 (DB) 或 R2/S3 存储桶，或在环境变量设置 ACCESS_PASSWORD。' }, 400);
        }
      } else {
        return jsonRes({ error: '开启全站登录拦截前，请先设定管理员密码（至少 4 位字符），避免锁站后无法验证身份。' }, 400);
      }
    }

    const okSaved = await setD1Setting(env, 'login_gate', enabled ? '1' : '0');
    if (!okSaved) {
      return jsonRes({ error: 'Edge 模式下持久化登录门禁开关需要绑定 Cloudflare D1 (DB) 或 R2 (BUCKET)/S3 存储桶，或设置环境变量 REQUIRE_LOGIN_GATE=true。' }, 400);
    }
    const updatedHash = await getEdgeAdminPasswordHash(env);
    return jsonRes({
      ok: true,
      requireLoginGate: enabled,
      hasAdminPassword: Boolean(env.ACCESS_PASSWORD || updatedHash),
      message: enabled
        ? '已开启全站访问限制：未登录管理员将看到登录拦截界面'
        : '已关闭全站访问限制：普通访客可直接进入工作台',
    });
  }

  if (pathname === '/api/auth/admin-password' && method === 'POST') {
    if (!(await isEdgeAdmin(request, env))) return jsonRes({ error: '仅限管理员操作' }, 401);
    const body = (await request.json().catch(() => ({}))) as { newPassword?: string; clearCustomPassword?: boolean };
    if (body.clearCustomPassword) {
      await deleteD1Setting(env, 'admin_pw_hash');
      return jsonRes({ ok: true, message: '已清除自定义密码', hasAdminPassword: Boolean(env.ACCESS_PASSWORD) });
    }
    const trimmed = (body.newPassword || '').trim();
    if (trimmed.length < 4) return jsonRes({ error: '密码至少 4 位字符' }, 400);
    const h = await sha256Hex(trimmed);
    const saved = await setD1Setting(env, 'admin_pw_hash', h);
    if (!saved) {
      return jsonRes({ error: 'Edge 模式下修改动态密码需绑定 D1 (DB) 或 R2/S3，或直接在环境变量修改 ACCESS_PASSWORD' }, 400);
    }
    return jsonRes({ ok: true, message: '管理员密码已保存', hasAdminPassword: true });
  }

  // OAuth callback (reachable directly from provider popup)
  if ((pathname === '/auth/callback' || pathname === '/auth/callback/') && method === 'GET') {
    const code = url.searchParams.get('code');
    const stateParam = url.searchParams.get('state') || '';
    const stateData = stateParam
      ? await verifyEdgeState(stateParam, getEdgeSecretSeed(env))
      : { provider: 'github', hostUrl: 'https://github.com' };

    if (!code || !stateData) {
      return new Response('Missing code or invalid OAuth state', { status: 400 });
    }
    const provider = (stateData.provider || 'github') as 'github' | 'gitlab' | 'gitee';
    const creds = await resolveEdgeGitOAuthCredentials(env, provider, stateData.hostUrl);
    if (!creds.clientId || !creds.clientSecret) {
      return new Response(`Missing ${provider.toUpperCase()} OAuth credentials`, { status: 400 });
    }

    const redirectUri = `${getAppUrl(request, env)}/auth/callback`;
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
      const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string };
      if (!tokenJson.access_token) return new Response(`GitHub OAuth error: ${tokenJson.error || 'unknown'}`, { status: 400 });
      accessToken = tokenJson.access_token;
      const userRes = await fetch('https://api.github.com/user', {
        headers: { authorization: `Bearer ${accessToken}`, 'user-agent': 'bcai-workbench' },
      });
      user = await userRes.json();
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
      const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string };
      if (!tokenJson.access_token) return new Response(`GitLab OAuth error: ${tokenJson.error || 'unknown'}`, { status: 400 });
      accessToken = tokenJson.access_token;
      const userRes = await fetch(`${creds.hostUrl}/api/v4/user`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const glUser = (await userRes.json()) as any;
      user = { login: glUser.username, name: glUser.name, avatar_url: glUser.avatar_url, provider: 'gitlab' };
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
      const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string };
      if (!tokenJson.access_token) return new Response(`Gitee OAuth error: ${tokenJson.error || 'unknown'}`, { status: 400 });
      accessToken = tokenJson.access_token;
      const userRes = await fetch(`https://gitee.com/api/v5/user?access_token=${encodeURIComponent(accessToken)}`);
      const geUser = (await userRes.json()) as any;
      user = { login: geUser.login, name: geUser.name, avatar_url: geUser.avatar_url, provider: 'gitee' };
    }

    const html = `<!doctype html><html><body><script>
      if (window.opener) {
        window.opener.postMessage({
          type: 'OAUTH_AUTH_SUCCESS',
          provider: ${JSON.stringify(provider)},
          hostUrl: ${JSON.stringify(creds.hostUrl)},
          user: ${JSON.stringify(user)},
          token: ${JSON.stringify(accessToken)}
        }, '*');
        window.close();
      } else { window.location.href = '/'; }
    </script><p>${provider.toUpperCase()} 授权成功，正在返回 BCAI 工作台...</p></body></html>`;

    const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' };
    if (provider === 'github') {
      headers['Set-Cookie'] = buildCookie('aimx_gh_token', accessToken);
    }
    return new Response(html, { headers });
  }

  // Enforce global login gate on AI & deploy routes when toggled ON
  if (
    (pathname === '/api/chat' ||
      pathname === '/api/image' ||
      pathname === '/api/providers/probe' ||
      pathname.startsWith('/api/deploy/')) &&
    (await getEdgeLoginGate(env)) &&
    !(await isEdgeAdmin(request, env))
  ) {
    return jsonRes({ error: '工作台已开启管理员登录拦截开关，请先登录管理员后使用。' }, 401);
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
        const probeModel = body.modelId === 'gemini-2.5-flash' ? 'gemini-3.1-flash-lite' : (body.modelId || 'gemini-3.1-flash-lite');
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
        try {
          const stream = (await env.AI.run(model, { messages: formatted, temperature, max_tokens: 8192, stream: true })) as ReadableStream;
          return new Response(stream, {
            headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
          });
        } catch {
          const stream = (await env.AI.run(model, { messages: formatted, temperature, stream: true })) as ReadableStream;
          return new Response(stream, {
            headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
          });
        }
      }
      const acc = accountId || env.CF_ACCOUNT_ID || '';
      const tok = apiKey || env.CF_API_TOKEN || '';
      if (!acc || !tok) {
        return jsonRes({ error: '未绑定 Cloudflare Workers AI (env.AI) 或 CF_ACCOUNT_ID/CF_API_TOKEN。' }, 400);
      }
      const callCfRest = (maxTokens?: number) =>
        fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(acc)}/ai/run/${model}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            messages: formatted,
            temperature,
            stream: true,
            ...(maxTokens ? { max_tokens: maxTokens } : {}),
          }),
        });
      let upstream = await callCfRest(8192);
      if (upstream.status === 400) {
        upstream = await callCfRest(4096);
        if (upstream.status === 400) upstream = await callCfRest(undefined);
      }
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { 'content-type': upstream.headers.get('content-type') || 'text/event-stream; charset=utf-8' },
      });
    }

    if (providerType === 'gemini') {
      const key = (source === 'custom' && apiKey) || env.GEMINI_API_KEY || '';
      if (!key) return jsonRes({ error: '未配置 GEMINI_API_KEY' }, 400);
      let effectiveModel = model === 'gemini-2.5-flash' ? 'gemini-4-hydrogen' : model;
      const sys = messages.find((m) => m.role === 'system')?.content;
      const contents: Array<{ role: string; parts: any[] }> = [];
      for (const m of messages) {
        if (m.role === 'system') continue;
        const role = m.role === 'assistant' ? 'model' : 'user';
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
        if (parts.length === 0) continue;
        if (contents.length === 0 && role === 'model') {
          contents.push({ role: 'user', parts: [{ text: '请继续。' }] });
        }
        const prev = contents[contents.length - 1];
        if (prev && prev.role === role) prev.parts.push(...parts);
        else contents.push({ role, parts });
      }
      if (contents.length === 0) contents.push({ role: 'user', parts: [{ text: '你好' }] });

      const callGeminiEdge = async (targetModel: string) => {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(targetModel)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;
        const generationConfig: Record<string, unknown> = {
          maxOutputTokens: 32768,
        };
        if (targetModel === 'gemini-4-hydrogen') {
          generationConfig.thinkingConfig = { thinkingLevel: 'MEDIUM' };
        }
        return fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            contents,
            ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}),
            generationConfig,
          }),
        });
      };

      let upstream = await callGeminiEdge(effectiveModel);
      if ((!upstream.ok || !upstream.body) && effectiveModel === 'gemini-4-hydrogen' && (upstream.status === 503 || upstream.status === 429)) {
        effectiveModel = 'gemini-3.1-flash-lite';
        upstream = await callGeminiEdge(effectiveModel);
      }
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
        let finishReason: string | undefined;
        let sentWriting = false;
        const emitLine = async (ln: string) => {
          if (!ln.startsWith('data:')) return;
          const raw = ln.slice(5).trim();
          if (!raw) return;
          try {
            const parsed = JSON.parse(raw);
            const candidate = parsed?.candidates?.[0];
            if (candidate?.finishReason) finishReason = String(candidate.finishReason);
            const parts = candidate?.content?.parts;
            const text = Array.isArray(parts)
              ? parts
                  .filter((p: any) => !p?.thought)
                  .map((p: any) => (typeof p?.text === 'string' ? p.text : ''))
                  .join('')
              : '';
            if (text) {
              if (!sentWriting) {
                sentWriting = true;
                await writer.write(encoder.encode(`data: ${JSON.stringify({ meta: { phase: 'writing', model: effectiveModel } })}\n\n`));
              }
              await writer.write(encoder.encode(`data: ${JSON.stringify({ response: text })}\n\n`));
            }
          } catch {
            // ignore
          }
        };
        try {
          await writer.write(encoder.encode(`data: ${JSON.stringify({ meta: { phase: 'connecting', model: effectiveModel } })}\n\n`));
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            for (const ln of lines) {
              await emitLine(ln);
            }
          }
          if (buf.trim()) {
            await emitLine(buf.trim());
          }
          if (finishReason === 'MAX_TOKENS') {
            await writer.write(encoder.encode(`data: ${JSON.stringify({ meta: { phase: 'truncated', finishReason, truncated: true, model: effectiveModel } })}\n\n`));
          } else {
            await writer.write(encoder.encode(`data: ${JSON.stringify({ meta: { phase: 'done', finishReason: finishReason || 'STOP', model: effectiveModel } })}\n\n`));
          }
          await writer.write(encoder.encode('data: [DONE]\n\n'));
        } finally {
          await writer.close();
        }
      })();
      return new Response(transform.readable, {
        headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform' },
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
    const callCompat = (maxTokens?: number) =>
      fetch(chatUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: formatted,
          temperature,
          stream: true,
          ...(maxTokens ? { max_tokens: maxTokens } : {}),
        }),
      });
    let upstream = await callCompat(8192);
    if (upstream.status === 400) {
      upstream = await callCompat(4096);
      if (upstream.status === 400) upstream = await callCompat(undefined);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') || 'text/event-stream; charset=utf-8' },
    });
  }

  // Multi-Engine Image Generation Endpoint (Pollinations Zero-Key / Workers AI / SiliconFlow Kolors / HuggingFace / OpenAI-Compatible)
  if (pathname === '/api/image' && method === 'POST') {
    const body = (await request.json()) as {
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
    if (!body.prompt || !body.prompt.trim()) {
      return jsonRes({ error: '请输入画面描述词' }, 400);
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

    const model = body.model || 'pollinations:flux';
    const providerType =
      body.providerType ||
      (model.startsWith('pollinations:') ? 'pollinations' : model.startsWith('@cf/') ? 'workers-ai' : 'pollinations');
    const enhanceMode: 'none' | 'translate' | 'enhance' =
      body.enhanceMode || (body.translate ? 'translate' : 'none');

    const w = Math.min(Math.max(Number(body.width) || 1024, 256), 1536);
    const h = Math.min(Math.max(Number(body.height) || 1024, 256), 1536);
    const seedNum =
      body.seed !== undefined && String(body.seed).trim() !== '' && !Number.isNaN(Number(body.seed))
        ? Number(body.seed)
        : undefined;

    let finalPrompt = body.prompt.trim();
    let finalNegative = (body.negativePrompt || '').trim();

    if (enhanceMode !== 'none') {
      const geminiKey = env.GEMINI_API_KEY && env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY' ? env.GEMINI_API_KEY : '';
      const askRewrite = async (instruction: string): Promise<string> => {
        if (geminiKey) {
          const r = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${encodeURIComponent(geminiKey)}`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: instruction }] }] }),
            }
          );
          if (r.ok) {
            const j = (await r.json()) as any;
            const t = j?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (typeof t === 'string' && t.trim()) return t.trim().replace(/^["']|["']$/g, '');
          }
        } else if (env.AI) {
          const tr = (await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
            messages: [{ role: 'user', content: instruction }],
          })) as { response?: string };
          if (tr?.response) return tr.response.trim().replace(/^["']|["']$/g, '');
        }
        return '';
      };

      try {
        if (enhanceMode === 'enhance') {
          const out = await askRewrite(
            `You are an expert visual prompt engineer for FLUX/SDXL/Kolors. Translate or refine this prompt into precise English, strictly preserving EVERY subject, count, spatial relation, color, action, and quoted text, while adding fitting lighting, composition, and texture (<= 95 words, output ONLY the final prompt):\n${finalPrompt}`
          );
          if (out) finalPrompt = out;
        } else if (/[\u4e00-\u9fff]/.test(finalPrompt)) {
          const out = await askRewrite(
            `Translate this image prompt accurately into concise, vivid English preserving all subjects, counts, and colors. Output ONLY the prompt:\n${finalPrompt}`
          );
          if (out) finalPrompt = out;
        }
        if (finalNegative && /[\u4e00-\u9fff]/.test(finalNegative)) {
          const outNeg = await askRewrite(
            `Translate these negative prompt tags into concise comma-separated English tags. Output ONLY the tags:\n${finalNegative}`
          );
          if (outNeg) finalNegative = outNeg;
        }
      } catch {
        // fallback to raw prompt
      }
    }

    const preset = body.stylePreset ? STYLE_SUFFIXES[body.stylePreset] : undefined;
    if (preset) {
      finalPrompt = `${finalPrompt}, ${preset.pos}`;
      finalNegative = finalNegative ? `${finalNegative}, ${preset.neg}` : preset.neg;
    }

    const imageHeaders = (ctype = 'image/png'): Record<string, string> => ({
      'content-type': ctype,
      'x-final-prompt': encodeURIComponent(finalPrompt),
      ...(finalNegative ? { 'x-final-negative': encodeURIComponent(finalNegative) } : {}),
    });

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
        return jsonRes({ error: `Pollinations HTTP ${upstream.status}: ${(await upstream.text()).slice(0, 160)}` }, upstream.status);
      }
      return new Response(upstream.body, {
        headers: imageHeaders(upstream.headers.get('content-type') || 'image/jpeg'),
      });
    }

    if (providerType === 'siliconflow') {
      const token = (body.apiKey || '').trim();
      if (!token) return jsonRes({ error: '请在外接绘图配置中填写 SiliconFlow API Key' }, 400);
      const target = (body.baseUrl || 'https://api.siliconflow.cn/v1/images/generations').trim();
      assertSafeExternalUrl(target);
      const upstream = await fetch(target, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: model || 'Kwai-Kolors/Kolors',
          prompt: finalPrompt,
          ...(finalNegative ? { negative_prompt: finalNegative } : {}),
          image_size: `${w}x${h}`,
          num_inference_steps: Math.min(Math.max(Number(body.steps) || 20, 1), 50),
          guidance_scale: Number(body.guidance) || 7.5,
          ...(seedNum !== undefined ? { seed: seedNum } : {}),
        }),
      });
      if (!upstream.ok) return jsonRes({ error: await upstream.text() }, upstream.status);
      const j = (await upstream.json()) as any;
      const b64 = j?.data?.[0]?.b64_json;
      if (b64) {
        const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        return new Response(bin, { headers: imageHeaders('image/png') });
      }
      const imgUrl = j?.images?.[0]?.url || j?.data?.[0]?.url;
      if (!imgUrl) return jsonRes({ error: 'SiliconFlow 未返回图像 URL' }, 500);
      assertSafeExternalUrl(imgUrl);
      const imgRes = await fetch(imgUrl);
      if (!imgRes.ok) return jsonRes({ error: `下载图像失败 HTTP ${imgRes.status}` }, 502);
      return new Response(imgRes.body, { headers: imageHeaders(imgRes.headers.get('content-type') || 'image/png') });
    }

    if (providerType === 'huggingface') {
      const token = (body.apiKey || '').trim();
      if (!token) return jsonRes({ error: '请在外接绘图配置中填写 Hugging Face Access Token' }, 400);
      const cleanBase = (body.baseUrl || 'https://router.huggingface.co/hf-inference/models').trim().replace(/\/+$/, '');
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
            num_inference_steps: Math.min(Math.max(Number(body.steps) || 25, 1), 50),
            guidance_scale: Number(body.guidance) || 7.5,
            ...(seedNum !== undefined ? { seed: seedNum } : {}),
          },
        }),
      });
      if (!upstream.ok) return jsonRes({ error: await upstream.text() }, upstream.status);
      return new Response(upstream.body, { headers: imageHeaders(upstream.headers.get('content-type') || 'image/png') });
    }

    if (providerType === 'openai-image') {
      const token = (body.apiKey || '').trim();
      if (!token) return jsonRes({ error: '请在外接绘图配置中填写兼容接口 API Key' }, 400);
      const cleanBase = (body.baseUrl || 'https://api.together.xyz/v1/images/generations').trim().replace(/\/+$/, '');
      const target = cleanBase.endsWith('/images/generations') ? cleanBase : `${cleanBase}/images/generations`;
      assertSafeExternalUrl(target);
      const upstream = await fetch(target, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt: finalPrompt, size: `${w}x${h}`, n: 1 }),
      });
      if (!upstream.ok) return jsonRes({ error: await upstream.text() }, upstream.status);
      const j = (await upstream.json()) as any;
      const b64 = j?.data?.[0]?.b64_json;
      if (b64) {
        const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        return new Response(bin, { headers: imageHeaders('image/png') });
      }
      const imgUrl = j?.data?.[0]?.url;
      if (!imgUrl) return jsonRes({ error: '外接绘图接口未返回图像 URL' }, 500);
      assertSafeExternalUrl(imgUrl);
      const imgRes = await fetch(imgUrl);
      if (!imgRes.ok) return jsonRes({ error: `下载图像失败 HTTP ${imgRes.status}` }, 502);
      return new Response(imgRes.body, { headers: imageHeaders(imgRes.headers.get('content-type') || 'image/png') });
    }

    // Workers AI Image Models
    const input: Record<string, unknown> = { prompt: finalPrompt, num_steps: body.steps || 4 };
    if (!model.includes('flux-1-schnell')) {
      input.width = w;
      input.height = h;
      if (finalNegative) input.negative_prompt = finalNegative;
      if (typeof body.guidance === 'number' && !Number.isNaN(body.guidance)) input.guidance = body.guidance;
    }
    if (seedNum !== undefined) {
      input.seed = seedNum;
    }

    if (env.AI && !body.apiKey) {
      const out = await env.AI.run(model, input);
      if (out && typeof out === 'object' && 'image' in (out as Record<string, unknown>)) {
        const b64 = (out as { image: string }).image;
        const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        return new Response(bin, { headers: imageHeaders('image/png') });
      }
      return new Response(out as BodyInit, { headers: imageHeaders('image/png') });
    }
    const acc = body.accountId || env.CF_ACCOUNT_ID || '';
    const tok = body.apiKey || env.CF_API_TOKEN || '';
    if (!acc || !tok) {
      return jsonRes({ error: '未绑定 Cloudflare Workers AI (env.AI) 或 CF_ACCOUNT_ID/CF_API_TOKEN（或先切换至顶部 Pollinations 免 Key 引擎）' }, 400);
    }
    const upstream = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(acc)}/ai/run/${model}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!upstream.ok) return jsonRes({ error: await upstream.text() }, upstream.status);
    return new Response(upstream.body, {
      headers: imageHeaders(upstream.headers.get('content-type') || 'image/png'),
    });
  }

  // Admin Guard for DB / Bucket / Sync / Git / Connectors
  const needsAdmin =
    pathname.startsWith('/api/db/') ||
    pathname.startsWith('/api/bucket/') ||
    pathname.startsWith('/api/sync/') ||
    pathname.startsWith('/api/git/') ||
    pathname.startsWith('/api/auth/git') ||
    pathname.startsWith('/api/connectors');

  if (needsAdmin && !(await isEdgeAdmin(request, env))) {
    return jsonRes({ error: '仅限管理员操作，请先在右上角点击“管理员登录”。' }, 401);
  }

  // Database Status / Items (Native D1 OR External Multi-DB)
  const extDb = getEdgeExternalDbConfig(env);

  if (pathname === '/api/db/status' && method === 'GET') {
    if (env.DB) {
      try {
        await ensureD1Schema(env);
        const row = await env.DB.prepare('SELECT COUNT(*) as cnt FROM media_assets').bind().first<{ cnt: number }>();
        return jsonRes({
          mode: 'cloudflare-d1-binding',
          provider: 'cf-d1-native',
          connected: true,
          d1Bound: true,
          label: 'Cloudflare D1 原生绑定 (env.DB)',
          itemCount: Number(row?.cnt || 0),
        });
      } catch (err: any) {
        return jsonRes({ mode: 'cloudflare-d1-binding', connected: false, d1Bound: true, label: err?.message });
      }
    }
    if (extDb) {
      try {
        const info = await testAndInitExternalDb(extDb);
        return jsonRes({
          mode: extDb.provider === 'd1-http' ? 'cloudflare-d1-http' : extDb.provider,
          provider: extDb.provider,
          connected: true,
          d1Bound: true,
          label: info.label,
          itemCount: info.count,
        });
      } catch (err: any) {
        return jsonRes({
          mode: extDb.provider,
          provider: extDb.provider,
          connected: false,
          d1Bound: true,
          label: `${dbProviderLabel(extDb.provider)} 连接异常: ${err?.message}`,
        });
      }
    }
    return jsonRes({ mode: 'unconfigured', connected: false, d1Bound: false, label: '未绑定远程数据库 (env.DB / Turso / Supabase / Neon)', itemCount: 0 });
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
    if (extDb) {
      const items = await listExternalDbAssets(extDb, typeFilter);
      return jsonRes({ mode: extDb.provider, items });
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
    if (extDb) {
      await upsertExternalDbAsset(extDb, {
        id,
        type: item.type || 'file',
        name: item.name || `asset-${Date.now()}`,
        mime_type: item.mimeType || 'text/plain',
        size_bytes: sizeBytes,
        prompt: item.prompt || '',
        model_id: item.modelId || '',
        content_data: contentData,
        repo_path: item.repoPath || '',
        storage_location: item.storageLocation || extDb.provider,
        bucket_key: item.bucketKey || '',
        created_at: now,
        updated_at: now,
      });
      return jsonRes({ ok: true, id, storageLocation: item.storageLocation || extDb.provider, updatedAt: now });
    }
    return jsonRes({ error: '未绑定数据库 (env.DB 或多数据库环境变量)' }, 400);
  }

  if (pathname.startsWith('/api/db/items/') && method === 'DELETE') {
    const id = decodeURIComponent(pathname.slice('/api/db/items/'.length));
    if (env.DB) {
      await ensureD1Schema(env);
      await env.DB.prepare('DELETE FROM media_assets WHERE id = ?').bind(id).run();
      return jsonRes({ ok: true });
    }
    if (extDb) {
      await deleteExternalDbAsset(extDb, id);
      return jsonRes({ ok: true });
    }
    return jsonRes({ error: '未绑定数据库' }, 400);
  }

  // Storage Bucket (Native R2 env.BUCKET or S3/OSS/COS HTTP)
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
          label: `S3/OSS/COS 存储桶已连通 (${s3.bucket})`,
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
    let dbOk = false;
    let bucketOk = false;
    const targets: string[] = [];
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
        dbOk = true;
        targets.push('d1');
      } catch (e: any) {
        errors.push(e?.message || 'D1 同步失败');
      }
    } else if (extDb) {
      try {
        await syncExternalDbConversations(extDb, conversations, now);
        dbOk = true;
        targets.push(extDb.provider);
      } catch (e: any) {
        errors.push(e?.message || '外部数据库同步失败');
      }
    }

    const s3 = getS3ConfigFromEnv(env);
    if (env.BUCKET) {
      try {
        await env.BUCKET.put('bcai-sync/conversations.json', JSON.stringify({ syncedAt: now, conversations }, null, 2));
        bucketOk = true;
        targets.push('bucket');
      } catch (e: any) {
        errors.push(e?.message || 'R2 同步失败');
      }
    } else if (s3) {
      try {
        await s3PutObject(s3, 'bcai-sync/conversations.json', JSON.stringify({ syncedAt: now, conversations }, null, 2), 'application/json');
        bucketOk = true;
        targets.push('bucket');
      } catch (e: any) {
        errors.push(e?.message || 'S3 同步失败');
      }
    }

    const ok = dbOk || bucketOk;
    if (!ok && errors.length === 0) {
      return jsonRes({ ok: false, error: '未绑定数据库或存储桶' }, 400);
    }
    return jsonRes({ ok, syncedAt: now, count: conversations.length, targets, errors }, ok ? 200 : 500);
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
    if (extDb) {
      const conversations = await fetchExternalDbConversations(extDb);
      return jsonRes({ ok: true, source: extDb.provider, conversations });
    }
    if (env.BUCKET) {
      const obj = await env.BUCKET.get('bcai-sync/conversations.json');
      if (!obj) return jsonRes({ error: '存储桶尚无同步记录' }, 404);
      const parsed = JSON.parse(await obj.text());
      return jsonRes({ ok: true, source: 'bucket', conversations: parsed.conversations || [] });
    }
    return jsonRes({ error: '未绑定数据库或存储桶' }, 400);
  }

  // Git OAuth Config & Auth URL
  if (pathname === '/api/git/oauth-config' && method === 'GET') {
    const saved = await getEdgeGitOAuthConfig(env);
    const gh = await resolveEdgeGitOAuthCredentials(env, 'github');
    const gl = await resolveEdgeGitOAuthCredentials(env, 'gitlab');
    const ge = await resolveEdgeGitOAuthCredentials(env, 'gitee');
    return jsonRes({
      siteId: saved.siteId || '',
      github: { clientId: gh.clientId, configured: Boolean(gh.clientId && gh.clientSecret) },
      gitlab: { clientId: gl.clientId, hostUrl: gl.hostUrl, configured: Boolean(gl.clientId && gl.clientSecret) },
      gitee: { clientId: ge.clientId, configured: Boolean(ge.clientId && ge.clientSecret) },
    });
  }

  if (pathname === '/api/git/oauth-config' && method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as {
      siteId?: string;
      provider?: 'github' | 'gitlab' | 'gitee';
      clientId?: string;
      clientSecret?: string;
      hostUrl?: string;
    };
    if (!env.DB) {
      return jsonRes({ error: 'Edge 模式下保存站点 OAuth 配置需绑定 D1 (env.DB)，也可直接设置 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET 环境变量。' }, 400);
    }
    const saved = await getEdgeGitOAuthConfig(env);
    if (typeof body.siteId === 'string') saved.siteId = body.siteId.trim();
    if (body.provider) {
      const prev = saved[body.provider] || {};
      saved[body.provider] = {
        clientId: typeof body.clientId === 'string' ? body.clientId.trim() : prev.clientId,
        clientSecret: body.clientSecret && body.clientSecret.trim() ? body.clientSecret.trim() : prev.clientSecret,
        ...(body.provider === 'gitlab' && body.hostUrl ? { hostUrl: body.hostUrl.trim().replace(/\/+$/, '') } : {}),
      };
    }
    await setD1Setting(env, 'git_oauth_config', JSON.stringify(saved));
    return jsonRes({ ok: true, siteId: saved.siteId || '', message: '已保存仓库站点 OAuth 应用与站点 ID 配置至 D1' });
  }

  if ((pathname === '/api/auth/git/url' || pathname === '/api/auth/github/url') && method === 'GET') {
    const provider = ((url.searchParams.get('provider') || 'github') as 'github' | 'gitlab' | 'gitee');
    const hostUrlParam = url.searchParams.get('hostUrl') || undefined;
    const creds = await resolveEdgeGitOAuthCredentials(env, provider, hostUrlParam);
    if (!creds.clientId || !creds.clientSecret) {
      return jsonRes({ error: `未配置 ${provider.toUpperCase()} OAuth Client ID / Secret。请在“连接仓库站点”区填写保存或改用 Token 连接。` }, 400);
    }
    const redirectUri = `${getAppUrl(request, env)}/auth/callback`;
    const state = await signEdgeState(
      { provider, hostUrl: creds.hostUrl, ts: Date.now() },
      getEdgeSecretSeed(env)
    );
    if (provider === 'github') {
      const params = new URLSearchParams({ client_id: creds.clientId, redirect_uri: redirectUri, scope: 'repo read:user', state });
      return jsonRes({ url: `https://github.com/login/oauth/authorize?${params.toString()}`, redirectUri });
    }
    if (provider === 'gitlab') {
      const params = new URLSearchParams({ client_id: creds.clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'api read_user write_repository', state });
      return jsonRes({ url: `${creds.hostUrl}/oauth/authorize?${params.toString()}`, redirectUri });
    }
    const params = new URLSearchParams({ client_id: creds.clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'user_info projects', state });
    return jsonRes({ url: `https://gitee.com/oauth/authorize?${params.toString()}`, redirectUri });
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
          'Set-Cookie': buildCookie('aimx_gh_token', clean),
        },
      });
    }
    if (provider === 'gitlab') {
      assertSafeExternalUrl(hostUrl);
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

  // Connectors CRUD + Probe + Save Code in Edge
  if (pathname === '/api/connectors' && method === 'GET') {
    const raw = await getD1Setting(env, 'connectors_list');
    const items = raw ? JSON.parse(raw) : [];
    return jsonRes({ items });
  }

  if (pathname === '/api/connectors' && method === 'POST') {
    const item = (await request.json().catch(() => ({}))) as Record<string, any>;
    if (!item?.name || !item?.category) return jsonRes({ error: '请填写连接器名称与分类' }, 400);
    const raw = await getD1Setting(env, 'connectors_list');
    const items: any[] = raw ? JSON.parse(raw) : [];
    const next = { ...item, id: item.id || `conn_${Date.now()}`, updatedAt: new Date().toISOString() };
    const idx = items.findIndex((x) => x.id === next.id);
    if (idx >= 0) items[idx] = next;
    else items.unshift(next);
    if (env.DB) await setD1Setting(env, 'connectors_list', JSON.stringify(items));
    return jsonRes({ ok: true, item: next });
  }

  if (pathname.startsWith('/api/connectors/') && method === 'DELETE') {
    const id = decodeURIComponent(pathname.slice('/api/connectors/'.length));
    const raw = await getD1Setting(env, 'connectors_list');
    const items: any[] = raw ? JSON.parse(raw) : [];
    if (env.DB) await setD1Setting(env, 'connectors_list', JSON.stringify(items.filter((x) => x.id !== id)));
    return jsonRes({ ok: true });
  }

  if (pathname === '/api/connectors/probe' && method === 'POST') {
    const { endpoint = '', secretToken = '' } = (await request.json().catch(() => ({}))) as any;
    if (!endpoint) return jsonRes({ status: 'unconfigured', message: '请填写端点 URL' });
    const start = Date.now();
    try {
      assertSafeExternalUrl(endpoint);
      const headers: Record<string, string> = {};
      if (secretToken) headers.authorization = `Bearer ${secretToken}`;
      const r = await fetch(endpoint, { headers });
      return jsonRes({ status: r.ok ? 'connected' : 'error', latencyMs: Date.now() - start, message: `HTTP ${r.status}` });
    } catch (e: any) {
      return jsonRes({ status: 'error', latencyMs: Date.now() - start, message: e?.message || '探测失败' });
    }
  }

  if (pathname === '/api/connectors/save-code' && method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as {
      connectorId: string;
      filename?: string;
      targetDir?: string;
      code: string;
      lang?: string;
      conversationTitle?: string;
      connector?: Record<string, any>;
    };
    if (!body.connectorId || !body.code) {
      return jsonRes({ error: '缺少 connectorId 或代码内容' }, 400);
    }
    const raw = await getD1Setting(env, 'connectors_list');
    const items: any[] = raw ? JSON.parse(raw) : [];
    const conn = items.find((c) => c.id === body.connectorId) || body.connector;
    if (!conn) return jsonRes({ error: '未找到对应的已连接连接器' }, 404);

    const cleanFile = (body.filename || `bcai-snippet-${Date.now()}.txt`).replace(/[/\\:*?"<>|]/g, '_').replace(/^\.+/, '');
    const baseDir = String(body.targetDir || conn.extraConfig || 'bcai-code')
      .split('/')
      .map((s) => s.trim())
      .filter((s) => s && s !== '.' && s !== '..')
      .join('/');
    const relPath = baseDir ? `${baseDir}/${cleanFile}` : cleanFile;

    try {
      if (conn.presetKey === 'webdav') {
        assertSafeExternalUrl(conn.endpoint);
        const putUrl = `${String(conn.endpoint).replace(/\/+$/, '')}/${relPath.split('/').map(encodeURIComponent).join('/')}`;
        const headers: Record<string, string> = { 'content-type': 'text/plain; charset=utf-8' };
        if (conn.usernameOrId && conn.secretToken) {
          headers.authorization = `Basic ${btoa(`${conn.usernameOrId}:${conn.secretToken}`)}`;
        } else if (conn.secretToken) {
          headers.authorization = `Bearer ${conn.secretToken}`;
        }
        const r = await fetch(putUrl, { method: 'PUT', headers, body: body.code });
        if (!r.ok && r.status !== 201 && r.status !== 204) throw new Error(`WebDAV HTTP ${r.status}`);
        return jsonRes({ ok: true, connectorName: conn.name, targetPath: relPath, message: `已写入 WebDAV：/${relPath}` });
      }
      if (conn.presetKey === 'alist') {
        assertSafeExternalUrl(conn.endpoint);
        const putUrl = `${String(conn.endpoint).replace(/\/+$/, '')}/api/fs/put`;
        const headers: Record<string, string> = {
          'content-type': 'text/plain; charset=utf-8',
          'file-path': encodeURIComponent(`/${relPath}`),
        };
        if (conn.secretToken) headers.authorization = conn.secretToken;
        const r = await fetch(putUrl, { method: 'PUT', headers, body: body.code });
        if (!r.ok) throw new Error(`Alist HTTP ${r.status}`);
        return jsonRes({ ok: true, connectorName: conn.name, targetPath: `/${relPath}`, message: `已存入 Alist 网盘：/${relPath}` });
      }
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
          lang: body.lang || 'text',
          code: body.code,
          conversationTitle: body.conversationTitle || '',
          savedAt: new Date().toISOString(),
        }),
      });
      if (!r.ok) throw new Error(`连接器返回 HTTP ${r.status}`);
      return jsonRes({ ok: true, connectorName: conn.name, targetPath: relPath, message: `已推送代码到连接器「${conn.name}」` });
    } catch (e: any) {
      return jsonRes({ error: e?.message || '存入连接器失败' }, 400);
    }
  }

  return jsonRes({ error: `Not found: ${pathname}` }, 404);
}

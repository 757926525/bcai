export type ExternalDbProvider = 'd1-http' | 'turso' | 'supabase' | 'neon' | 'upstash';

export interface ExternalDbConfig {
  provider: ExternalDbProvider;
  // D1 HTTP
  accountId?: string;
  databaseId?: string;
  apiToken?: string;
  // Turso / libSQL
  tursoUrl?: string;
  tursoAuthToken?: string;
  // Supabase REST
  supabaseUrl?: string;
  supabaseKey?: string;
  // Neon Serverless Postgres HTTP
  neonConnectionString?: string;
  // Upstash Redis REST
  upstashUrl?: string;
  upstashToken?: string;
}

export interface DbAssetRow {
  id: string;
  type: 'image' | 'file';
  name: string;
  mime_type: string;
  size_bytes: number;
  prompt?: string;
  model_id?: string;
  content_data: string;
  repo_path?: string;
  storage_location: string;
  bucket_key?: string;
  created_at: string;
  updated_at: string;
}

function toTursoArgs(params: unknown[]) {
  return params.map((p) => {
    if (p === null || p === undefined) return { type: 'null', value: null };
    if (typeof p === 'number') {
      return Number.isInteger(p)
        ? { type: 'integer', value: String(p) }
        : { type: 'float', value: p };
    }
    return { type: 'text', value: String(p) };
  });
}

async function execTurso(cfg: ExternalDbConfig, sql: string, params: unknown[] = []): Promise<any[]> {
  const rawUrl = (cfg.tursoUrl || '').trim().replace(/^libsql:\/\//i, 'https://').replace(/\/+$/, '');
  if (!rawUrl || !cfg.tursoAuthToken) throw new Error('缺少 Turso URL 或 Auth Token');
  const res = await fetch(`${rawUrl}/v2/pipeline`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.tursoAuthToken.trim()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      requests: [
        { type: 'execute', stmt: { sql, args: toTursoArgs(params) } },
        { type: 'close' },
      ],
    }),
  });
  const data = (await res.json()) as any;
  if (!res.ok) throw new Error(data?.message || `Turso HTTP ${res.status}`);
  const first = data?.results?.[0];
  if (first?.type === 'error') throw new Error(first?.error?.message || 'Turso SQL 错误');
  const result = first?.response?.result;
  if (!result || !Array.isArray(result.cols)) return [];
  const cols: string[] = result.cols.map((c: any) => c.name);
  return (result.rows || []).map((row: any[]) => {
    const obj: Record<string, unknown> = {};
    cols.forEach((c, idx) => {
      const cell = row[idx];
      obj[c] = cell?.type === 'integer' ? Number(cell.value) : cell?.value ?? null;
    });
    return obj;
  });
}

function qToPgParams(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function execNeon(cfg: ExternalDbConfig, sql: string, params: unknown[] = []): Promise<any[]> {
  const conn = (cfg.neonConnectionString || '').trim();
  if (!conn) throw new Error('缺少 Neon Connection String');
  const u = new URL(conn.replace(/^postgresql:\/\//i, 'https://').replace(/^postgres:\/\//i, 'https://'));
  const endpoint = `https://${u.hostname}/sql`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'neon-connection-string': conn,
    },
    body: JSON.stringify({ query: qToPgParams(sql), params }),
  });
  const data = (await res.json()) as any;
  if (!res.ok) throw new Error(data?.message || data?.error || `Neon HTTP ${res.status}`);
  return Array.isArray(data?.rows) ? data.rows : [];
}

async function execUpstash(cfg: ExternalDbConfig, command: unknown[]): Promise<any> {
  const url = (cfg.upstashUrl || '').trim().replace(/\/+$/, '');
  const token = (cfg.upstashToken || '').trim();
  if (!url || !token) throw new Error('缺少 Upstash REST URL 或 Token');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  const data = (await res.json()) as { result?: any; error?: string };
  if (!res.ok || data.error) throw new Error(data.error || `Upstash HTTP ${res.status}`);
  return data.result;
}

export async function queryD1Http(
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

const SQLITE_MEDIA_DDL = `CREATE TABLE IF NOT EXISTS media_assets (
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
)`;

const SQLITE_CONVS_DDL = `CREATE TABLE IF NOT EXISTS conversations (
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
)`;

export function dbProviderLabel(provider: ExternalDbProvider): string {
  if (provider === 'd1-http') return 'Cloudflare D1';
  if (provider === 'turso') return 'Turso (libSQL)';
  if (provider === 'supabase') return 'Supabase (Postgres REST)';
  if (provider === 'neon') return 'Neon (Serverless Postgres)';
  return 'Upstash Redis REST';
}

export async function testAndInitExternalDb(cfg: ExternalDbConfig): Promise<{ count: number; label: string }> {
  if (cfg.provider === 'd1-http') {
    if (!cfg.accountId || !cfg.databaseId || !cfg.apiToken) {
      throw new Error('请填写完整的 Account ID、D1 Database ID 和 API Token');
    }
    await queryD1Http(cfg.accountId, cfg.databaseId, cfg.apiToken, SQLITE_MEDIA_DDL);
    await queryD1Http(cfg.accountId, cfg.databaseId, cfg.apiToken, SQLITE_CONVS_DDL);
    try {
      await queryD1Http(cfg.accountId, cfg.databaseId, cfg.apiToken, `ALTER TABLE media_assets ADD COLUMN storage_location TEXT NOT NULL DEFAULT 'd1'`);
    } catch { /* ignore */ }
    try {
      await queryD1Http(cfg.accountId, cfg.databaseId, cfg.apiToken, `ALTER TABLE media_assets ADD COLUMN bucket_key TEXT`);
    } catch { /* ignore */ }
    try {
      await queryD1Http(cfg.accountId, cfg.databaseId, cfg.apiToken, `ALTER TABLE conversations ADD COLUMN messages_json TEXT`);
    } catch { /* ignore */ }
    const rows = await queryD1Http(cfg.accountId, cfg.databaseId, cfg.apiToken, 'SELECT COUNT(*) as cnt FROM media_assets');
    return { count: Number(rows?.[0]?.cnt ?? 0), label: 'Cloudflare D1 远程数据库已连通' };
  }

  if (cfg.provider === 'turso') {
    await execTurso(cfg, SQLITE_MEDIA_DDL);
    await execTurso(cfg, SQLITE_CONVS_DDL);
    const rows = await execTurso(cfg, 'SELECT COUNT(*) as cnt FROM media_assets');
    return { count: Number(rows?.[0]?.cnt ?? 0), label: 'Turso / libSQL 数据库已连通' };
  }

  if (cfg.provider === 'neon') {
    await execNeon(cfg, SQLITE_MEDIA_DDL);
    await execNeon(cfg, SQLITE_CONVS_DDL);
    const rows = await execNeon(cfg, 'SELECT COUNT(*)::int as cnt FROM media_assets');
    return { count: Number(rows?.[0]?.cnt ?? 0), label: 'Neon Postgres 数据库已连通' };
  }

  if (cfg.provider === 'supabase') {
    const base = (cfg.supabaseUrl || '').trim().replace(/\/+$/, '');
    const key = (cfg.supabaseKey || '').trim();
    if (!base || !key) throw new Error('请填写 Supabase URL 与 API Key');
    const r = await fetch(`${base}/rest/v1/media_assets?select=id&limit=100`, {
      headers: { apikey: key, authorization: `Bearer ${key}` },
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`Supabase 连接失败 HTTP ${r.status}: ${txt.slice(0, 120)}（请确认已在 SQL Editor 执行 schema.sql 建表）`);
    }
    const rows = (await r.json()) as any[];
    return { count: Array.isArray(rows) ? rows.length : 0, label: 'Supabase Postgres 已连通' };
  }

  // Upstash Redis
  await execUpstash(cfg, ['PING']);
  const keys = (await execUpstash(cfg, ['HKEYS', 'bcai:media_assets'])) as string[] | null;
  return { count: Array.isArray(keys) ? keys.length : 0, label: 'Upstash Redis REST 已连通' };
}

export async function listExternalDbAssets(cfg: ExternalDbConfig, typeFilter = ''): Promise<DbAssetRow[]> {
  if (cfg.provider === 'd1-http') {
    const rows = typeFilter
      ? await queryD1Http(cfg.accountId!, cfg.databaseId!, cfg.apiToken!, 'SELECT * FROM media_assets WHERE type = ? ORDER BY updated_at DESC LIMIT 100', [typeFilter])
      : await queryD1Http(cfg.accountId!, cfg.databaseId!, cfg.apiToken!, 'SELECT * FROM media_assets ORDER BY updated_at DESC LIMIT 100');
    return rows.map((r) => ({ ...r, storage_location: r.storage_location || 'd1' }));
  }

  if (cfg.provider === 'turso') {
    const rows = typeFilter
      ? await execTurso(cfg, 'SELECT * FROM media_assets WHERE type = ? ORDER BY updated_at DESC LIMIT 100', [typeFilter])
      : await execTurso(cfg, 'SELECT * FROM media_assets ORDER BY updated_at DESC LIMIT 100');
    return rows.map((r) => ({ ...r, storage_location: r.storage_location || 'turso' }));
  }

  if (cfg.provider === 'neon') {
    const rows = typeFilter
      ? await execNeon(cfg, 'SELECT * FROM media_assets WHERE type = ? ORDER BY updated_at DESC LIMIT 100', [typeFilter])
      : await execNeon(cfg, 'SELECT * FROM media_assets ORDER BY updated_at DESC LIMIT 100');
    return rows.map((r) => ({ ...r, storage_location: r.storage_location || 'neon' }));
  }

  if (cfg.provider === 'supabase') {
    const base = (cfg.supabaseUrl || '').trim().replace(/\/+$/, '');
    const key = (cfg.supabaseKey || '').trim();
    const filterQ = typeFilter ? `&type=eq.${encodeURIComponent(typeFilter)}` : '';
    const r = await fetch(`${base}/rest/v1/media_assets?select=*&order=updated_at.desc&limit=100${filterQ}`, {
      headers: { apikey: key, authorization: `Bearer ${key}` },
    });
    if (!r.ok) throw new Error(`Supabase 读取失败 HTTP ${r.status}`);
    const rows = (await r.json()) as DbAssetRow[];
    return rows.map((row) => ({ ...row, storage_location: row.storage_location || 'supabase' }));
  }

  const raw = (await execUpstash(cfg, ['HVALS', 'bcai:media_assets'])) as string[] | null;
  const parsed: DbAssetRow[] = (Array.isArray(raw) ? raw : [])
    .map((s) => {
      try {
        return JSON.parse(s) as DbAssetRow;
      } catch {
        return null;
      }
    })
    .filter((x): x is DbAssetRow => Boolean(x));
  const filtered = typeFilter ? parsed.filter((i) => i.type === typeFilter) : parsed;
  return filtered.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
}

export async function upsertExternalDbAsset(cfg: ExternalDbConfig, record: DbAssetRow): Promise<void> {
  if (cfg.provider === 'd1-http') {
    await queryD1Http(
      cfg.accountId!,
      cfg.databaseId!,
      cfg.apiToken!,
      `INSERT OR REPLACE INTO media_assets
       (id, type, name, mime_type, size_bytes, prompt, model_id, content_data, repo_path, storage_location, bucket_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.type,
        record.name,
        record.mime_type,
        record.size_bytes,
        record.prompt || '',
        record.model_id || '',
        record.content_data,
        record.repo_path || '',
        record.storage_location,
        record.bucket_key || '',
        record.created_at,
        record.updated_at,
      ]
    );
    return;
  }

  if (cfg.provider === 'turso') {
    await execTurso(
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
        record.prompt || '',
        record.model_id || '',
        record.content_data,
        record.repo_path || '',
        record.storage_location,
        record.bucket_key || '',
        record.created_at,
        record.updated_at,
      ]
    );
    return;
  }

  if (cfg.provider === 'neon') {
    await execNeon(
      cfg,
      `INSERT INTO media_assets
       (id, type, name, mime_type, size_bytes, prompt, model_id, content_data, repo_path, storage_location, bucket_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, mime_type = EXCLUDED.mime_type, size_bytes = EXCLUDED.size_bytes,
         content_data = EXCLUDED.content_data, storage_location = EXCLUDED.storage_location,
         bucket_key = EXCLUDED.bucket_key, updated_at = EXCLUDED.updated_at`,
      [
        record.id,
        record.type,
        record.name,
        record.mime_type,
        record.size_bytes,
        record.prompt || '',
        record.model_id || '',
        record.content_data,
        record.repo_path || '',
        record.storage_location,
        record.bucket_key || '',
        record.created_at,
        record.updated_at,
      ]
    );
    return;
  }

  if (cfg.provider === 'supabase') {
    const base = (cfg.supabaseUrl || '').trim().replace(/\/+$/, '');
    const key = (cfg.supabaseKey || '').trim();
    const r = await fetch(`${base}/rest/v1/media_assets`, {
      method: 'POST',
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify(record),
    });
    if (!r.ok) throw new Error(`Supabase 写入失败 HTTP ${r.status}`);
    return;
  }

  await execUpstash(cfg, ['HSET', 'bcai:media_assets', record.id, JSON.stringify(record)]);
}

export async function deleteExternalDbAsset(cfg: ExternalDbConfig, id: string): Promise<void> {
  if (cfg.provider === 'd1-http') {
    await queryD1Http(cfg.accountId!, cfg.databaseId!, cfg.apiToken!, 'DELETE FROM media_assets WHERE id = ?', [id]);
    return;
  }
  if (cfg.provider === 'turso') {
    await execTurso(cfg, 'DELETE FROM media_assets WHERE id = ?', [id]);
    return;
  }
  if (cfg.provider === 'neon') {
    await execNeon(cfg, 'DELETE FROM media_assets WHERE id = ?', [id]);
    return;
  }
  if (cfg.provider === 'supabase') {
    const base = (cfg.supabaseUrl || '').trim().replace(/\/+$/, '');
    const key = (cfg.supabaseKey || '').trim();
    const r = await fetch(`${base}/rest/v1/media_assets?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { apikey: key, authorization: `Bearer ${key}` },
    });
    if (!r.ok) throw new Error(`Supabase 删除失败 HTTP ${r.status}`);
    return;
  }
  await execUpstash(cfg, ['HDEL', 'bcai:media_assets', id]);
}

export async function deleteExternalDbAssetByBucketKey(cfg: ExternalDbConfig, bucketKey: string): Promise<void> {
  if (cfg.provider === 'd1-http') {
    await queryD1Http(cfg.accountId!, cfg.databaseId!, cfg.apiToken!, 'DELETE FROM media_assets WHERE bucket_key = ?', [bucketKey]);
    return;
  }
  if (cfg.provider === 'turso') {
    await execTurso(cfg, 'DELETE FROM media_assets WHERE bucket_key = ?', [bucketKey]);
    return;
  }
  if (cfg.provider === 'neon') {
    await execNeon(cfg, 'DELETE FROM media_assets WHERE bucket_key = ?', [bucketKey]);
    return;
  }
  if (cfg.provider === 'supabase') {
    const base = (cfg.supabaseUrl || '').trim().replace(/\/+$/, '');
    const key = (cfg.supabaseKey || '').trim();
    await fetch(`${base}/rest/v1/media_assets?bucket_key=eq.${encodeURIComponent(bucketKey)}`, {
      method: 'DELETE',
      headers: { apikey: key, authorization: `Bearer ${key}` },
    });
    return;
  }
  const assets = await listExternalDbAssets(cfg);
  for (const a of assets) {
    if (a.bucket_key === bucketKey) {
      await execUpstash(cfg, ['HDEL', 'bcai:media_assets', a.id]);
    }
  }
}

export async function syncExternalDbConversations(cfg: ExternalDbConfig, conversations: any[], now: string): Promise<void> {
  if (cfg.provider === 'd1-http' || cfg.provider === 'turso') {
    const runFn =
      cfg.provider === 'd1-http'
        ? (sql: string, params: unknown[]) => queryD1Http(cfg.accountId!, cfg.databaseId!, cfg.apiToken!, sql, params)
        : (sql: string, params: unknown[]) => execTurso(cfg, sql, params);
    for (const c of conversations.slice(0, 80)) {
      await runFn(
        `INSERT OR REPLACE INTO conversations
         (id, title, mode, model_id, provider_id, repo_full_name, repo_branch, status, messages_json, storage_location, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          cfg.provider === 'd1-http' ? 'd1' : 'turso',
          c.createdAt || now,
          c.updatedAt || now,
        ]
      );
    }
    return;
  }

  if (cfg.provider === 'neon') {
    for (const c of conversations.slice(0, 80)) {
      await execNeon(
        cfg,
        `INSERT INTO conversations
         (id, title, mode, model_id, provider_id, repo_full_name, repo_branch, status, messages_json, storage_location, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'neon', ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title, messages_json = EXCLUDED.messages_json, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`,
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
    return;
  }

  if (cfg.provider === 'supabase') {
    const base = (cfg.supabaseUrl || '').trim().replace(/\/+$/, '');
    const key = (cfg.supabaseKey || '').trim();
    const rows = conversations.slice(0, 80).map((c) => ({
      id: c.id,
      title: c.title || '未命名会话',
      mode: c.mode || 'chat',
      model_id: c.modelId || '',
      provider_id: c.providerId || '',
      repo_full_name: c.repoFullName || '',
      repo_branch: c.repoBranch || '',
      status: c.status || 'active',
      messages_json: JSON.stringify(c.messages || []),
      storage_location: 'supabase',
      created_at: c.createdAt || now,
      updated_at: c.updatedAt || now,
    }));
    const r = await fetch(`${base}/rest/v1/conversations`, {
      method: 'POST',
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify(rows),
    });
    if (!r.ok) throw new Error(`Supabase 会话同步失败 HTTP ${r.status}`);
    return;
  }

  await execUpstash(cfg, ['SET', 'bcai:conversations', JSON.stringify({ syncedAt: now, conversations })]);
}

export async function fetchExternalDbConversations(cfg: ExternalDbConfig): Promise<any[]> {
  if (cfg.provider === 'upstash') {
    const raw = (await execUpstash(cfg, ['GET', 'bcai:conversations'])) as string | null;
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { conversations?: any[] };
    return parsed.conversations || [];
  }

  let rows: any[] = [];
  if (cfg.provider === 'd1-http') {
    rows = await queryD1Http(cfg.accountId!, cfg.databaseId!, cfg.apiToken!, 'SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 80');
  } else if (cfg.provider === 'turso') {
    rows = await execTurso(cfg, 'SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 80');
  } else if (cfg.provider === 'neon') {
    rows = await execNeon(cfg, 'SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 80');
  } else {
    const base = (cfg.supabaseUrl || '').trim().replace(/\/+$/, '');
    const key = (cfg.supabaseKey || '').trim();
    const r = await fetch(`${base}/rest/v1/conversations?select=*&order=updated_at.desc&limit=80`, {
      headers: { apikey: key, authorization: `Bearer ${key}` },
    });
    if (!r.ok) throw new Error(`Supabase 读取失败 HTTP ${r.status}`);
    rows = (await r.json()) as any[];
  }

  return rows.map((r) => ({
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
}

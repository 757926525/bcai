import { checkAccess, PagesContext } from '../_types';

export async function onRequestGet(context: PagesContext): Promise<Response> {
  const denied = checkAccess(context.request, context.env);
  if (denied) return denied;

  const url = new URL(context.request.url);
  const action = url.searchParams.get('action') || 'items';

  if (action === 'status') {
    return new Response(
      JSON.stringify({
        mode: context.env.DB ? 'cloudflare-d1-binding' : 'unconfigured',
        connected: Boolean(context.env.DB),
        label: context.env.DB ? 'Cloudflare D1 原生绑定 (env.DB)' : '未绑定 D1',
      }),
      { headers: { 'content-type': 'application/json' } }
    );
  }

  if (!context.env.DB) {
    return new Response(JSON.stringify({ items: [], warning: '未检测到 env.DB 绑定' }), {
      headers: { 'content-type': 'application/json' },
    });
  }

  const typeFilter = url.searchParams.get('type');
  const stmt = typeFilter
    ? context.env.DB.prepare('SELECT * FROM media_assets WHERE type = ? ORDER BY updated_at DESC LIMIT 100').bind(typeFilter)
    : context.env.DB.prepare('SELECT * FROM media_assets ORDER BY updated_at DESC LIMIT 100');
  const { results } = await stmt.all();
  return new Response(JSON.stringify({ items: results }), {
    headers: { 'content-type': 'application/json' },
  });
}

export async function onRequestPost(context: PagesContext): Promise<Response> {
  const denied = checkAccess(context.request, context.env);
  if (denied) return denied;
  if (!context.env.DB) {
    return new Response(JSON.stringify({ error: '未绑定 Cloudflare D1 (env.DB)' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const item = (await context.request.json()) as {
    id: string;
    type: 'image' | 'file';
    name: string;
    mimeType: string;
    sizeBytes: number;
    prompt?: string;
    modelId?: string;
    contentData: string;
    repoPath?: string;
    createdAt?: string;
    updatedAt?: string;
  };
  const now = new Date().toISOString();
  await context.env.DB.prepare(
    `INSERT OR REPLACE INTO media_assets
     (id, type, name, mime_type, size_bytes, prompt, model_id, content_data, repo_path, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      item.id,
      item.type,
      item.name,
      item.mimeType,
      item.sizeBytes || 0,
      item.prompt || '',
      item.modelId || '',
      item.contentData,
      item.repoPath || '',
      item.createdAt || now,
      item.updatedAt || now
    )
    .run();

  return new Response(JSON.stringify({ ok: true, id: item.id, updatedAt: now }), {
    headers: { 'content-type': 'application/json' },
  });
}

export async function onRequestDelete(context: PagesContext): Promise<Response> {
  const denied = checkAccess(context.request, context.env);
  if (denied) return denied;
  if (!context.env.DB) {
    return new Response(JSON.stringify({ error: '未绑定 Cloudflare D1 (env.DB)' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
  const url = new URL(context.request.url);
  const id = url.searchParams.get('id');
  if (!id) {
    return new Response(JSON.stringify({ error: '缺少 id 参数' }), { status: 400 });
  }
  await context.env.DB.prepare('DELETE FROM media_assets WHERE id = ?').bind(id).run();
  return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
}

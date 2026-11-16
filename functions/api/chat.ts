import { checkAccess, PagesContext } from '../_types';

export async function onRequestPost(context: PagesContext): Promise<Response> {
  const denied = checkAccess(context.request, context.env);
  if (denied) return denied;

  const body = (await context.request.json()) as {
    model: string;
    messages: Array<{ role: string; content: string }>;
    temperature?: number;
    providerType?: string;
    baseUrl?: string;
    apiKey?: string;
  };

  const { model, messages, temperature = 0.7, providerType = 'workers-ai', baseUrl, apiKey } = body;

  // 1. Native Cloudflare Workers AI binding (free tier built-in)
  if (providerType === 'workers-ai' || model.startsWith('@cf/')) {
    if (context.env.AI) {
      const stream = (await context.env.AI.run(model, {
        messages,
        temperature,
        stream: true,
      })) as ReadableStream;
      return new Response(stream, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
        },
      });
    }
    if (context.env.CF_ACCOUNT_ID && context.env.CF_API_TOKEN) {
      const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${context.env.CF_ACCOUNT_ID}/ai/run/${model}`;
      const upstream = await fetch(cfUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${context.env.CF_API_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ messages, temperature, stream: true }),
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { 'content-type': upstream.headers.get('content-type') || 'text/event-stream' },
      });
    }
    return new Response(JSON.stringify({ error: '未绑定 Cloudflare Workers AI (env.AI) 或 CF_ACCOUNT_ID/CF_API_TOKEN。' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  // 2. Google Gemini REST streaming in Edge Workers
  if (providerType === 'gemini') {
    const key = apiKey || context.env.GEMINI_API_KEY;
    if (!key) {
      return new Response(JSON.stringify({ error: '未配置 GEMINI_API_KEY。' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    const sys = messages.find((m) => m.role === 'system')?.content;
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));
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
      const txt = await upstream.text();
      return new Response(JSON.stringify({ error: txt || 'Gemini 请求失败' }), {
        status: upstream.status,
        headers: { 'content-type': 'application/json' },
      });
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
              if (text) {
                await writer.write(encoder.encode(`data: ${JSON.stringify({ response: text })}\n\n`));
              }
            } catch {
              // ignore partial chunks
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

  // 3. OpenAI-compatible (DeepSeek, Groq, OpenRouter, Custom)
  let targetUrl = baseUrl || '';
  let token = apiKey || '';
  if (providerType === 'deepseek') {
    targetUrl = targetUrl || context.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
    token = token || context.env.DEEPSEEK_API_KEY || '';
  } else if (providerType === 'groq') {
    targetUrl = targetUrl || context.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
    token = token || context.env.GROQ_API_KEY || '';
  } else if (providerType === 'openrouter') {
    targetUrl = targetUrl || 'https://openrouter.ai/api/v1';
    token = token || context.env.OPENROUTER_API_KEY || '';
  } else {
    targetUrl = targetUrl || context.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    token = token || context.env.OPENAI_API_KEY || '';
  }

  if (!token) {
    return new Response(JSON.stringify({ error: `未配置 ${providerType} 的 API Key。` }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const cleanBase = targetUrl.replace(/\/+$/, '');
  const chatEndpoint = cleanBase.endsWith('/chat/completions') ? cleanBase : `${cleanBase}/chat/completions`;
  const upstream = await fetch(chatEndpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, messages, temperature, stream: true }),
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') || 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
    },
  });
}

import { checkAccess, PagesContext } from '../_types';

export async function onRequestPost(context: PagesContext): Promise<Response> {
  const denied = checkAccess(context.request, context.env);
  if (denied) return denied;

  const body = (await context.request.json()) as {
    prompt: string;
    model: string;
    steps?: number;
    width?: number;
    height?: number;
    translate?: boolean;
  };

  let finalPrompt = body.prompt;
  const hasCjk = /[\u4e00-\u9fff]/.test(finalPrompt);

  if (body.translate && hasCjk && context.env.AI) {
    try {
      const tr = (await context.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [
          {
            role: 'system',
            content: 'Translate the following image prompt into concise, vivid English for Stable Diffusion/FLUX. Output ONLY the English prompt.',
          },
          { role: 'user', content: finalPrompt },
        ],
      })) as { response?: string };
      if (tr?.response) finalPrompt = tr.response.trim();
    } catch {
      // fallback to original prompt
    }
  }

  const input: Record<string, unknown> = { prompt: finalPrompt, num_steps: body.steps || 4 };
  if (!body.model.includes('flux')) {
    input.width = body.width || 1024;
    input.height = body.height || 1024;
  }

  if (context.env.AI) {
    const out = await context.env.AI.run(body.model, input);
    if (out && typeof out === 'object' && 'image' in (out as Record<string, unknown>)) {
      const b64 = (out as { image: string }).image;
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return new Response(bin, {
        headers: {
          'content-type': 'image/png',
          'x-final-prompt': encodeURIComponent(finalPrompt),
        },
      });
    }
    return new Response(out as BodyInit, {
      headers: {
        'content-type': 'image/png',
        'x-final-prompt': encodeURIComponent(finalPrompt),
      },
    });
  }

  if (context.env.CF_ACCOUNT_ID && context.env.CF_API_TOKEN) {
    const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${context.env.CF_ACCOUNT_ID}/ai/run/${body.model}`;
    const res = await fetch(cfUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${context.env.CF_API_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      return new Response(await res.text(), { status: res.status });
    }
    return new Response(res.body, {
      headers: {
        'content-type': res.headers.get('content-type') || 'image/png',
        'x-final-prompt': encodeURIComponent(finalPrompt),
      },
    });
  }

  return new Response(JSON.stringify({ error: '未绑定 Cloudflare Workers AI (env.AI) 或 CF_ACCOUNT_ID/CF_API_TOKEN。' }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
}

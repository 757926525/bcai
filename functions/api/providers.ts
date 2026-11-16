import { PagesContext } from '../_types';

export async function onRequestGet(context: PagesContext): Promise<Response> {
  const env = context.env;
  return new Response(
    JSON.stringify({
      runtime: 'cloudflare-pages',
      requiresPassword: Boolean(env.ACCESS_PASSWORD),
      bindings: {
        workersAiNative: Boolean(env.AI),
        workersAiApi: Boolean(env.CF_ACCOUNT_ID && env.CF_API_TOKEN),
        d1Native: Boolean(env.DB),
        gemini: Boolean(env.GEMINI_API_KEY),
        deepseek: Boolean(env.DEEPSEEK_API_KEY),
        groq: Boolean(env.GROQ_API_KEY),
        openrouter: Boolean(env.OPENROUTER_API_KEY),
        openai: Boolean(env.OPENAI_API_KEY),
        githubOAuth: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
      },
    }),
    { headers: { 'content-type': 'application/json' } }
  );
}

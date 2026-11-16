import { PagesContext } from '../_types';

export async function onRequestGet(context: PagesContext): Promise<Response> {
  const url = new URL(context.request.url);
  const code = url.searchParams.get('code');
  if (!code || !context.env.GITHUB_CLIENT_ID || !context.env.GITHUB_CLIENT_SECRET) {
    return new Response('Missing OAuth code or GitHub OAuth credentials.', { status: 400 });
  }

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      client_id: context.env.GITHUB_CLIENT_ID,
      client_secret: context.env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });
  const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tokenJson.access_token) {
    return new Response(`GitHub OAuth error: ${tokenJson.error || 'unknown'}`, { status: 400 });
  }

  const userRes = await fetch('https://api.github.com/user', {
    headers: {
      authorization: `Bearer ${tokenJson.access_token}`,
      'user-agent': 'aimx-workbench',
    },
  });
  const user = await userRes.json();

  const html = `<!doctype html><html><body><script>
    if (window.opener) {
      window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS', provider: 'github', user: ${JSON.stringify(user)}, token: ${JSON.stringify(tokenJson.access_token)} }, '*');
      window.close();
    } else {
      window.location.href = '/';
    }
  </script><p>GitHub 授权成功，窗口正在关闭...</p></body></html>`;

  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

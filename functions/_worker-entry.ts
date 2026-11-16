import { handleEdgeRequest } from './_edge-app';
import { type CFEnv } from './_types';

export default {
  async fetch(request: Request, env: CFEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/callback')) {
      return handleEdgeRequest(request, env);
    }
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('Not Found', { status: 404 });
  },
};

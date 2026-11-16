import { handleEdgeRequest } from '../functions/_edge-app';
import { type CFEnv } from '../functions/_types';

export const config = {
  runtime: 'edge',
};

export default async function handler(request: Request): Promise<Response> {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const env = (proc?.env || {}) as unknown as CFEnv;
  return handleEdgeRequest(request, env);
}

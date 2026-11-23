import { handleEdgeRequest } from '../_edge-app';
import { type PagesContext } from '../_types';

export async function onRequest(context: PagesContext): Promise<Response> {
  return handleEdgeRequest(context.request, context.env);
}

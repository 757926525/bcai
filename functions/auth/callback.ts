import { handleEdgeRequest } from '../_edge-app';
import { type PagesContext } from '../_types';

export async function onRequestGet(context: PagesContext): Promise<Response> {
  return handleEdgeRequest(context.request, context.env);
}

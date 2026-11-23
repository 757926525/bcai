import { ChatAttachment, ExternalProvider, ProviderStatusInfo } from '../types';

export interface StreamMetaEvent {
  phase?: 'connecting' | 'thinking' | 'writing' | 'fallback' | 'truncated' | 'blocked' | 'done';
  model?: string;
  fromModel?: string;
  finishReason?: string;
  truncated?: boolean;
  limitNotice?: string;
}

export interface StreamDoneResult {
  truncated: boolean;
  interrupted: boolean;
  finishReason?: string;
  activeModel?: string;
  limitNotice?: string;
}

export class StreamHttpError extends Error {
  status?: number;
  modelId?: string;
  providerType?: string;

  constructor(message: string, status?: number, modelId?: string, providerType?: string) {
    super(message);
    this.name = 'StreamHttpError';
    this.status = status;
    this.modelId = modelId;
    this.providerType = providerType;
  }
}

export interface StreamCallbacks {
  onChunk: (delta: string) => void;
  onMeta?: (meta: StreamMetaEvent) => void;
  onDone: (result: StreamDoneResult) => void;
  onError: (err: Error) => void;
}

export interface StreamMessagePayload {
  role: string;
  content: string;
  attachments?: ChatAttachment[];
}

function buildDirectOpenAIMessages(messages: StreamMessagePayload[]): Array<{ role: string; content: unknown }> {
  return messages.map((m) => {
    let text = m.content || '';
    const files = (m.attachments || []).filter((a) => a.kind === 'file' && a.textContent);
    if (files.length > 0) {
      text += files
        .map((f) => `\n\n[附带文件: ${f.name} (${f.mimeType})]\n\`\`\`\n${(f.textContent || '').slice(0, 24000)}\n\`\`\``)
        .join('');
    }
    const images = (m.attachments || []).filter((a) => a.kind === 'image' && a.dataUrl);
    if (images.length > 0 && m.role === 'user') {
      return {
        role: m.role,
        content: [
          { type: 'text', text: text || '请结合附带的图片进行详细分析。' },
          ...images.map((img) => ({ type: 'image_url', image_url: { url: img.dataUrl } })),
        ],
      };
    }
    return { role: m.role, content: text };
  });
}

export async function probeProviderConnection(
  provider: ExternalProvider,
  accessPassword?: string
): Promise<ProviderStatusInfo> {
  const start = Date.now();
  const checkedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false });

  if (
    provider.source === 'custom' &&
    provider.directStream &&
    provider.providerType !== 'gemini' &&
    provider.providerType !== 'workers-ai'
  ) {
    if (!provider.apiKey.trim()) {
      return {
        status: 'unconfigured',
        message: '未填写 API Key',
        checkedAt,
      };
    }
    try {
      const cleanBase = provider.baseUrl.replace(/\/+$/, '');
      const modelsUrl = cleanBase.endsWith('/models') ? cleanBase : `${cleanBase}/models`;
      const res = await fetch(modelsUrl, {
        headers: {
          authorization: `Bearer ${provider.apiKey.trim()}`,
        },
      });
      if (!res.ok) {
        const text = await res.text();
        return {
          status: 'error',
          latencyMs: Date.now() - start,
          message: `直连验证失败 HTTP ${res.status}: ${text.slice(0, 90)}`,
          checkedAt,
        };
      }
      return {
        status: 'connected',
        latencyMs: Date.now() - start,
        message: '客户端直连探测正常',
        checkedAt,
      };
    } catch {
      // Fallback to backend probe in case of CORS restriction on /models
    }
  }

  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (accessPassword) {
      headers['x-access-password'] = encodeURIComponent(accessPassword);
    }
    const res = await fetch('/api/providers/probe', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        providerType: provider.providerType,
        source: provider.source,
        baseUrl: provider.baseUrl,
        apiKey: provider.source === 'custom' ? provider.apiKey : undefined,
        accountId: provider.source === 'custom' ? provider.accountId : undefined,
        modelId: provider.models[0],
      }),
    });
    const data = (await res.json()) as {
      status: 'connected' | 'unconfigured' | 'error';
      latencyMs?: number;
      message?: string;
    };
    return {
      status: data.status || 'error',
      latencyMs: data.latencyMs,
      message: data.message || '探测完成',
      checkedAt,
    };
  } catch (err: any) {
    return {
      status: 'error',
      latencyMs: Date.now() - start,
      message: err?.message || '探测请求失败',
      checkedAt,
    };
  }
}

class UpstreamStreamError extends StreamHttpError {
  constructor(message: string, status?: number, modelId?: string, providerType?: string) {
    super(message, status, modelId, providerType);
    this.name = 'UpstreamStreamError';
  }
}

export async function streamChatCompletion(params: {
  modelId: string;
  provider?: ExternalProvider;
  messages: StreamMessagePayload[];
  temperature: number;
  accessPassword?: string;
  signal: AbortSignal;
  callbacks: StreamCallbacks;
}): Promise<void> {
  const { modelId, provider, messages, temperature, accessPassword, signal, callbacks } = params;

  const canDirectClientStream =
    provider &&
    provider.source === 'custom' &&
    provider.directStream &&
    provider.apiKey.trim() !== '' &&
    provider.providerType !== 'gemini' &&
    provider.providerType !== 'workers-ai';

  const fetchBackendProxy = () => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (accessPassword) {
      headers['x-access-password'] = encodeURIComponent(accessPassword);
    }
    return fetch('/api/chat', {
      method: 'POST',
      signal,
      headers,
      body: JSON.stringify({
        model: modelId,
        messages,
        temperature,
        providerType: provider?.providerType || (modelId.startsWith('@cf/') ? 'workers-ai' : 'openai-compatible'),
        source: provider?.source || 'env',
        baseUrl: provider?.baseUrl,
        apiKey: provider?.source === 'custom' ? provider.apiKey : undefined,
        accountId: provider?.source === 'custom' ? provider.accountId : undefined,
      }),
    });
  };

  try {
    let res: Response | null = null;

    if (canDirectClientStream && provider) {
      const cleanBase = provider.baseUrl.replace(/\/+$/, '');
      const endpoint = cleanBase.endsWith('/chat/completions') ? cleanBase : `${cleanBase}/chat/completions`;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          signal,
          headers: {
            authorization: `Bearer ${provider.apiKey.trim()}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: modelId,
            messages: buildDirectOpenAIMessages(messages),
            temperature,
            stream: true,
          }),
        });
      } catch (directErr: any) {
        if (directErr?.name === 'AbortError' || signal.aborted) {
          throw directErr;
        }
        // Automatic fallback to backend /api/chat proxy if CORS or network blocks direct browser SSE
        res = await fetchBackendProxy();
      }
    } else {
      res = await fetchBackendProxy();
    }

    if (!res.ok) {
      let errText = '';
      try {
        errText = await res.text();
        const parsed = JSON.parse(errText);
        if (parsed?.error) {
          let inner = typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error);
          try {
            const nested = JSON.parse(inner);
            if (nested?.error?.message) inner = nested.error.message;
          } catch {
            // keep inner
          }
          errText = inner;
        }
      } catch {
        // use raw text
      }
      throw new StreamHttpError(
        errText.slice(0, 320) || `请求失败 (HTTP ${res.status})`,
        res.status,
        modelId,
        provider?.providerType
      );
    }

    if (!res.body) {
      throw new StreamHttpError('响应体为空，无法读取流式数据', res.status, modelId, provider?.providerType);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let receivedDone = false;
    let truncated = false;
    let finishReason: string | undefined;
    let limitNotice: string | undefined;
    let activeModel = modelId;
    let receivedContent = false;
    let inReasoningBlock = false;

    const processLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) return;
      const payload = trimmed.slice(5).trim();
      if (!payload) return;
      if (payload === '[DONE]') {
        if (inReasoningBlock) {
          inReasoningBlock = false;
          callbacks.onChunk('\n</think>\n\n');
        }
        receivedDone = true;
        return;
      }

      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        // Ignore partial/non-JSON keepalive lines instead of breaking the stream
        return;
      }

      if (json?.error) {
        const errMsg = typeof json.error === 'string' ? json.error : json.error.message || '模型返回错误';
        const errCode = typeof json.error === 'object' ? Number(json.error.code || json.error.status) || undefined : undefined;
        throw new UpstreamStreamError(errMsg, errCode, activeModel, provider?.providerType);
      }

      if (json?.meta) {
        const meta = json.meta as StreamMetaEvent;
        if (meta.model) activeModel = meta.model;
        if (meta.finishReason) finishReason = meta.finishReason;
        if (meta.truncated) truncated = true;
        if (meta.limitNotice) limitNotice = meta.limitNotice;
        callbacks.onMeta?.(meta);
        return;
      }

      const choiceFinish = json?.choices?.[0]?.finish_reason;
      if (choiceFinish) {
        finishReason = String(choiceFinish);
        const lowFinish = finishReason.toLowerCase();
        if (lowFinish === 'length' || lowFinish === 'max_tokens') {
          truncated = true;
          callbacks.onMeta?.({ phase: 'truncated', finishReason, truncated: true, model: activeModel });
        } else if (lowFinish === 'content_filter' || lowFinish === 'safety' || lowFinish === 'recitation') {
          limitNotice = `触发模型安全/合规策略限制 (${finishReason})`;
          callbacks.onMeta?.({ phase: 'blocked', finishReason, limitNotice, model: activeModel });
        }
      }

      const deltaObj = json?.choices?.[0]?.delta;
      let piece = '';
      if (typeof json?.response === 'string') {
        piece = json.response;
      } else if (deltaObj) {
        if (typeof deltaObj.reasoning_content === 'string' && deltaObj.reasoning_content) {
          if (!inReasoningBlock) {
            inReasoningBlock = true;
            piece += '<think>\n';
          }
          piece += deltaObj.reasoning_content;
        }
        if (typeof deltaObj.content === 'string' && deltaObj.content) {
          if (inReasoningBlock) {
            inReasoningBlock = false;
            piece += '\n</think>\n\n';
          }
          piece += deltaObj.content;
        }
      }
      if (piece) {
        if (!receivedContent) {
          receivedContent = true;
          callbacks.onMeta?.({ phase: 'writing', model: activeModel });
        }
        callbacks.onChunk(piece);
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        processLine(line);
      }
    }
    if (buffer.trim()) {
      processLine(buffer);
    }
    if (inReasoningBlock) {
      inReasoningBlock = false;
      callbacks.onChunk('\n</think>\n\n');
    }

    const interrupted = (!receivedDone && !signal.aborted) || (!receivedContent && !signal.aborted);
    callbacks.onDone({
      truncated,
      interrupted,
      finishReason,
      activeModel,
      limitNotice,
    });
  } catch (err: any) {
    callbacks.onError(err instanceof Error ? err : new Error(String(err)));
  }
}

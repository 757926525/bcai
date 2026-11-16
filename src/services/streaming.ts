import { ExternalProvider, ProviderStatusInfo } from '../types';

export interface StreamCallbacks {
  onChunk: (delta: string) => void;
  onDone: () => void;
  onError: (err: Error) => void;
}

export async function probeProviderConnection(
  provider: ExternalProvider,
  accessPassword?: string
): Promise<ProviderStatusInfo> {
  const start = Date.now();
  const checkedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false });

  // Custom client-side probe when directStream is enabled and apiKey exists
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

export async function streamChatCompletion(params: {
  modelId: string;
  provider?: ExternalProvider;
  messages: Array<{ role: string; content: string }>;
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

  try {
    let res: Response;

    if (canDirectClientStream && provider) {
      // Direct secure client-side HTTPS SSE streaming
      const cleanBase = provider.baseUrl.replace(/\/+$/, '');
      const endpoint = cleanBase.endsWith('/chat/completions') ? cleanBase : `${cleanBase}/chat/completions`;
      res = await fetch(endpoint, {
        method: 'POST',
        signal,
        headers: {
          authorization: `Bearer ${provider.apiKey.trim()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: modelId,
          messages,
          temperature,
          stream: true,
        }),
      });
    } else {
      // Backend proxy SSE streaming (supports Gemini SDK, Workers AI, or backend env keys)
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (accessPassword) {
        headers['x-access-password'] = encodeURIComponent(accessPassword);
      }
      res = await fetch('/api/chat', {
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
    }

    if (!res.ok) {
      let errText = '';
      try {
        errText = await res.text();
        const parsed = JSON.parse(errText);
        if (parsed?.error) {
          errText = typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error);
        }
      } catch {
        // use raw text
      }
      throw new Error(errText.slice(0, 320) || `请求失败 (HTTP ${res.status})`);
    }

    if (!res.body) {
      throw new Error('响应体为空，无法读取流式数据');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          if (json?.error) {
            throw new Error(typeof json.error === 'string' ? json.error : json.error.message || '模型返回错误');
          }
          // Support Workers AI ({ response }), OpenAI/DeepSeek/Groq ({ choices[0].delta }), and reasoning_content
          const deltaObj = json?.choices?.[0]?.delta;
          let piece = '';
          if (typeof json?.response === 'string') {
            piece = json.response;
          } else if (deltaObj) {
            if (typeof deltaObj.reasoning_content === 'string' && deltaObj.reasoning_content) {
              piece = deltaObj.reasoning_content;
            }
            if (typeof deltaObj.content === 'string' && deltaObj.content) {
              piece += deltaObj.content;
            }
          }
          if (piece) {
            callbacks.onChunk(piece);
          }
        } catch (parseErr: any) {
          if (parseErr?.message && !parseErr.message.includes('JSON')) {
            throw parseErr;
          }
        }
      }
    }

    callbacks.onDone();
  } catch (err: any) {
    callbacks.onError(err instanceof Error ? err : new Error(String(err)));
  }
}

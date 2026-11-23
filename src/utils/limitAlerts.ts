import { ImageModelOption, ModelOption, WorkspaceMode } from '../types';

export type LimitCategory =
  | 'rate_limit'
  | 'quota_exhausted'
  | 'max_tokens'
  | 'context_length'
  | 'safety_filter'
  | 'overloaded'
  | 'missing_credentials'
  | 'stream_interrupted'
  | 'unknown';

export interface ModelLimitAlert {
  id: string;
  scope: 'chat' | 'image';
  category: LimitCategory;
  title: string;
  summary: string;
  detail: string;
  suggestion: string;
  modelId: string;
  providerType?: string;
  statusCode?: number;
  finishReason?: string;
  canContinuePartial?: boolean;
  canRetryCurrent?: boolean;
  recommendedModelId?: string;
  recommendedProviderId?: string;
  recommendedModelLabel?: string;
}

export function classifyLimitError(params: {
  scope: 'chat' | 'image';
  rawMessage: string;
  statusCode?: number;
  finishReason?: string;
  modelId: string;
  providerType?: string;
  writtenCount?: number;
  missingFiles?: string[];
}): ModelLimitAlert {
  const { scope, rawMessage, statusCode, finishReason, modelId, providerType, writtenCount, missingFiles } = params;
  const msg = (rawMessage || '').trim();
  const low = msg.toLowerCase();
  const frLow = (finishReason || '').toLowerCase();

  let category: LimitCategory = 'unknown';
  let title = scope === 'image' ? '绘图模型受限提示' : '编程/对话模型受限提示';
  let summary = msg || '模型调用触发限制或返回异常，请查看下方处理建议。';
  let suggestion = '你可以一键切换至下方推荐的可用模型继续任务，或在系统设置中检查 API 凭证与额度。';

  if (
    statusCode === 402 ||
    low.includes('insufficient') ||
    low.includes('balance') ||
    low.includes('billing') ||
    low.includes('credit') ||
    low.includes('paid') ||
    low.includes('payment required') ||
    low.includes('exceeded your current quota')
  ) {
    category = 'quota_exhausted';
    title = '模型额度不足或需付费权限';
    summary = `当前模型 (${modelId}) 账户额度已用尽或属于付费层级限制。`;
    suggestion = '建议一键切换至工作台内置免费模型，或更换其他可用 API Key 后继续。';
  } else if (
    statusCode === 429 ||
    low.includes('429') ||
    low.includes('rate limit') ||
    low.includes('too many requests') ||
    low.includes('resource_exhausted') ||
    low.includes('rpm') ||
    low.includes('rpd') ||
    low.includes('tpm') ||
    low.includes('neurons') ||
    low.includes('限流')
  ) {
    category = 'rate_limit';
    title = '触发模型频率 / 每日免费配额限制 (429)';
    summary =
      providerType === 'workers-ai'
        ? `Cloudflare Workers AI (${modelId}) 触发频率或每日 10,000 Neurons 限额。`
        : `模型 (${modelId}) 当前请求过快或已达到免费 RPM/RPD 配额上限。`;
    suggestion = '等待几秒后重试，或立即切换至其他免费备用通道/模型继续任务。';
  } else if (
    statusCode === 413 ||
    low.includes('context length') ||
    low.includes('context_length_exceeded') ||
    low.includes('maximum context') ||
    low.includes('too many tokens') ||
    low.includes('prompt is too long') ||
    low.includes('payload too large') ||
    low.includes('token limit')
  ) {
    category = 'context_length';
    title = '超出模型上下文长度限制';
    summary = `当前会话历史或附带代码文件总长度超出了 ${modelId} 允许的最大上下文窗口。`;
    suggestion = '建议切换至 128K / 1M 大上下文模型（如 Gemini 3.1 Flash Lite 或 OpenRouter/Groq 长窗口模型），或新建会话精简输入。';
  } else if (
    frLow === 'safety' ||
    frLow === 'recitation' ||
    frLow === 'blocklist' ||
    frLow === 'prohibited_content' ||
    frLow === 'content_filter' ||
    low.includes('safety') ||
    low.includes('content_filter') ||
    low.includes('nsfw') ||
    low.includes('blocked')
  ) {
    category = 'safety_filter';
    title = '触发模型安全 / 合规策略截断';
    summary = `模型 (${modelId}) 因内容安全过滤或复述保护策略 (${finishReason || 'POLICY'}) 中止了继续输出。`;
    suggestion = '请调整提示词或需求表述，或切换其他模型继续编写。';
  } else if (
    frLow === 'max_tokens' ||
    frLow === 'length' ||
    low.includes('max_tokens') ||
    low.includes('truncated') ||
    low.includes('尚未完整') ||
    low.includes('仍待补全')
  ) {
    category = 'max_tokens';
    title = '已达单次/自动续写输出上限，项目尚有未写完部分';
    summary =
      writtenCount && writtenCount > 0
        ? `模型 (${modelId}) 已连续续写并输出 ${writtenCount} 个模块，但受单轮输出配额或上下文预算限制仍未全部收尾。`
        : `模型 (${modelId}) 输出长度已达单轮上限。`;
    suggestion =
      missingFiles && missingFiles.length > 0
        ? `待补全文件：${missingFiles.slice(0, 5).join(', ')}。可点击下方「继续断点续写」或切换长输出模型补齐剩余文件。`
        : '点击下方「继续断点续写」即可紧接当前断点继续写出剩余代码。';
  } else if (
    statusCode === 400 &&
    (low.includes('未配置') || low.includes('missing') || low.includes('未绑定') || low.includes('api key'))
  ) {
    category = 'missing_credentials';
    title = '当前模型缺少 API 密钥或环境绑定';
    summary = msg || `模型 (${modelId}) 尚未配置可用 API Key 或平台凭证。`;
    suggestion =
      scope === 'image'
        ? '可一键切换至内置免 Key 的 Pollinations FLUX.1 免费绘图引擎，或在「外接免费绘图 API」中填入 Key。'
        : '可一键切换至已配置连通的模型，或在左下角「外接 API 与系统设置」中填入 Key。';
  } else if (statusCode === 401 || statusCode === 403 || low.includes('unauthorized') || low.includes('invalid api key')) {
    category = 'missing_credentials';
    title = '模型身份鉴权失败或 Key 无效';
    summary = `模型 (${modelId}) 返回鉴权拒绝（HTTP ${statusCode || 401}），可能是 API Key 错误、失效或工作台已开启管理员门禁。`;
    suggestion = '请检查 API Key 是否有效、管理员是否已登录，或切换其他可用模型。';
  } else if (
    statusCode === 503 ||
    statusCode === 504 ||
    low.includes('503') ||
    low.includes('504') ||
    low.includes('unavailable') ||
    low.includes('high demand') ||
    low.includes('overloaded') ||
    low.includes('timeout') ||
    low.includes('超时')
  ) {
    category = 'overloaded';
    title = '模型高负载 / 响应超时限制';
    summary = `模型 (${modelId}) 当前并发排队人数较多或请求超时，上游服务暂时不可用。`;
    suggestion = '建议立即重试或切换至低延迟备用模型继续。';
  } else if (low.includes('中断') || low.includes('interrupted') || low.includes('network') || low.includes('failed to fetch')) {
    category = 'stream_interrupted';
    title = '流式输出连接意外中断';
    summary = msg || `与模型 (${modelId}) 的流式连接在中途断开，已输出的内容均已保留。`;
    suggestion = '可点击「继续断点续写」紧接着已写完的最后一行无损续写，或换一个稳定模型。';
  }

  return {
    id: `limit_${Date.now()}`,
    scope,
    category,
    title,
    summary,
    detail: msg,
    suggestion,
    modelId,
    providerType,
    statusCode,
    finishReason,
    canContinuePartial: scope === 'chat',
    canRetryCurrent: category === 'rate_limit' || category === 'overloaded' || category === 'stream_interrupted' || category === 'unknown',
  };
}

export function pickFallbackChatModel(
  currentModelId: string,
  allModels: ModelOption[],
  providerStatuses: Record<string, { status: string }>,
  mode: WorkspaceMode
): ModelOption | undefined {
  const candidates = allModels.filter((m) => m.id !== currentModelId);
  // 1. Prefer verified connected models matching coding/chat strengths
  const connected = candidates.filter((m) => providerStatuses[m.providerId]?.status === 'connected');
  if (connected.length > 0) {
    if (mode === 'code' || mode === 'repo') {
      return (
        connected.find((m) => m.id === 'gemini-3.1-flash-lite') ||
        connected.find((m) => m.id.includes('coder') || m.id.includes('deepseek') || m.id.includes('qwen')) ||
        connected[0]
      );
    }
    return connected.find((m) => m.id === 'gemini-3.1-flash-lite') || connected[0];
  }
  // 2. Otherwise prefer zero-friction built-in / flash lite
  return (
    candidates.find((m) => m.id === 'gemini-3.1-flash-lite') ||
    candidates.find((m) => m.id === '@cf/qwen/qwen2.5-coder-32b-instruct') ||
    candidates[0]
  );
}

export function pickFallbackImageModel(
  currentModelId: string,
  builtinModels: ImageModelOption[]
): ImageModelOption | undefined {
  const others = builtinModels.filter((m) => m.id !== currentModelId);
  // Prefer zero-key Pollinations models so fallback works without any extra credential
  return (
    others.find((m) => !m.requiresKey && m.id === 'pollinations:flux') ||
    others.find((m) => !m.requiresKey && m.id === 'pollinations:turbo') ||
    others.find((m) => !m.requiresKey) ||
    others[0]
  );
}

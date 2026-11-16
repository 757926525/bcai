export type WorkspaceMode = 'chat' | 'code' | 'image' | 'repo';

export type ProviderType =
  | 'workers-ai'
  | 'gemini'
  | 'deepseek'
  | 'groq'
  | 'openrouter'
  | 'openai-compatible';

export type ModelZone = 'original' | 'free-extended';

export type ConnectionState = 'unconfigured' | 'checking' | 'connected' | 'error';

export interface ProviderStatusInfo {
  status: ConnectionState;
  latencyMs?: number;
  message: string;
  checkedAt?: string;
}

export interface ExternalProvider {
  id: string;
  name: string;
  providerType: ProviderType;
  source: 'env' | 'custom';
  baseUrl: string;
  apiKey: string;
  accountId?: string;
  models: string[];
  directStream: boolean;
  isFreeTier: boolean;
  quotaNote: string;
  enabled: boolean;
}

export interface ModelOption {
  id: string;
  name: string;
  providerId: string;
  providerType: ProviderType;
  zone: ModelZone;
  isFree: boolean;
  quotaSummary: string;
  contextWindow: string;
  streamMode: 'direct' | 'proxy';
  note?: string;
}

export interface ImageModelOption {
  id: string;
  name: string;
  defaultSteps: number;
  maxSteps: number;
  supportsCustomSize: boolean;
  quotaSummary: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  modelId?: string;
  createdAt: string;
  paused?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  mode: 'chat' | 'code' | 'repo';
  modelId: string;
  providerId: string;
  repoFullName?: string;
  repoBranch?: string;
  attachedFilePath?: string;
  attachedFileContent?: string;
  status: 'active' | 'paused';
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface GeneratedImageCard {
  id: string;
  prompt: string;
  finalPrompt: string;
  modelId: string;
  url: string;
  dataUrl?: string;
  createdAt: string;
  savedToDb?: boolean;
  error?: string;
  loading?: boolean;
}

export interface SavedAsset {
  id: string;
  type: 'image' | 'file';
  name: string;
  mime_type: string;
  size_bytes: number;
  prompt?: string;
  model_id?: string;
  content_data: string;
  repo_path?: string;
  created_at: string;
  updated_at: string;
}

export interface PublicConfig {
  requiresPassword: boolean;
  unlocked: boolean;
  appUrl: string;
  envProviders: {
    workersAi: boolean;
    gemini: boolean;
    deepseek: boolean;
    groq: boolean;
    openrouter: boolean;
    openai: boolean;
    openaiBaseUrl: string;
    openaiModels: string[];
  };
  d1Bound: boolean;
  githubOAuthConfigured: boolean;
}

export interface GitHubUser {
  login: string;
  avatar_url?: string;
  name?: string;
  html_url?: string;
}

export interface GitHubRepo {
  id: number;
  full_name: string;
  name: string;
  default_branch: string;
  private: boolean;
  description?: string;
  html_url: string;
}

export interface GitHubTreeItem {
  path: string;
  type: 'blob' | 'tree';
  size?: number;
  sha: string;
}

export interface ProviderGuide {
  providerType: ProviderType;
  title: string;
  badge: string;
  endpoint: string;
  quotaDetail: string;
  rateLimits: string;
  corsDirectSupport: boolean;
  steps: string[];
  usageTips: string;
  applyUrl: string;
}

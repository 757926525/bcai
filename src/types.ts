export type WorkspaceMode = 'code' | 'image' | 'chat' | 'repo' | 'connectors';

export type ThemeId =
  | 'cf-native'
  | 'slate-cobalt'
  | 'emerald-studio'
  | 'warm-paper'
  | 'midnight-obsidian'
  | 'indigo-dusk';

export type LayoutMode = 'auto' | 'mobile' | 'desktop';

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
  supportsVision?: boolean;
  note?: string;
}

export interface ImageModelOption {
  id: string;
  name: string;
  defaultSteps: number;
  maxSteps: number;
  supportsCustomSize: boolean;
  supportsNegativePrompt: boolean;
  quotaSummary: string;
}

export interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'file';
  dataUrl?: string;
  textContent?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  modelId?: string;
  attachments?: ChatAttachment[];
  createdAt: string;
  paused?: boolean;
  truncated?: boolean;
  interrupted?: boolean;
  finishReason?: string;
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
  negativePrompt?: string;
  finalPrompt: string;
  modelId: string;
  guidance?: number;
  seed?: string;
  url: string;
  dataUrl?: string;
  createdAt: string;
  savedToDb?: boolean;
  savedToBucket?: boolean;
  error?: string;
  loading?: boolean;
}

export type StorageLocationType = 'd1' | 'bucket' | 'local';

export type DbProviderType = 'd1-http' | 'turso' | 'supabase' | 'neon' | 'upstash';

export type S3AddressingStyle = 'path' | 'virtual';

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
  storage_location?: StorageLocationType;
  bucket_key?: string;
  created_at: string;
  updated_at: string;
}

export interface StorageBucketConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  addressingStyle?: S3AddressingStyle;
  publicBaseUrl?: string;
}

export interface BucketStatusInfo {
  configured: boolean;
  connected: boolean;
  mode: 'cf-r2-binding' | 's3-http' | 'unconfigured' | 'error';
  label: string;
  bucketName?: string;
  itemCount?: number;
  error?: string;
}

export interface DbStatusInfo {
  mode: string;
  provider?: string;
  connected: boolean;
  d1Bound: boolean;
  label: string;
  itemCount?: number;
  error?: string;
}

export interface SyncStatusInfo {
  status: 'idle' | 'syncing' | 'success' | 'error';
  message: string;
  lastSyncedAt?: string;
  syncedTarget?: string;
}

export interface PublicConfig {
  isAdmin: boolean;
  hasAdminPassword: boolean;
  usingEnvPassword: boolean;
  requireLoginGate?: boolean;
  defaultTargetRepoUrl: string;
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
  dbProvider?: string;
  bucketBound: boolean;
  githubOAuthConfigured: boolean;
  gitOAuthProviders?: {
    github: boolean;
    gitlab: boolean;
    gitee: boolean;
  };
}

export interface GitOAuthConfigSummary {
  siteId?: string;
  github: { clientId: string; configured: boolean };
  gitlab: { clientId: string; hostUrl: string; configured: boolean };
  gitee: { clientId: string; configured: boolean };
}

export type GitProviderType = 'github' | 'gitlab' | 'gitee';

export interface GitUser {
  login: string;
  avatar_url?: string;
  name?: string;
  html_url?: string;
  provider?: GitProviderType;
}

export interface GitRepo {
  id: number | string;
  full_name: string;
  name: string;
  default_branch: string;
  private: boolean;
  description?: string;
  html_url: string;
}

export interface GitTreeItem {
  path: string;
  type: 'blob' | 'tree';
  size?: number;
  sha: string;
}

export type ConnectorCategory = 'cloud-disk' | 'email' | 'deploy' | 'other';

export interface ConnectorItem {
  id: string;
  category: ConnectorCategory;
  presetKey: string;
  name: string;
  endpoint: string;
  usernameOrId?: string;
  secretToken?: string;
  extraConfig?: string;
  status: ConnectionState;
  statusMessage?: string;
  latencyMs?: number;
  checkedAt?: string;
  updatedAt: string;
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

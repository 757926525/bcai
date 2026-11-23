import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Code2,
  Database,
  Download,
  FolderGit2,
  Image as ImageIcon,
  Laptop,
  Lock,
  Menu,
  MessageSquare,
  Moon,
  Palette,
  Pause,
  Play,
  Plug,
  Plus,
  Rocket,
  Settings,
  ShieldCheck,
  Smartphone,
  Square,
  Sun,
  Trash2,
  X,
} from 'lucide-react';
import { AuthPlanModal } from './components/AuthPlanModal';
import { ChatWorkspace } from './components/ChatWorkspace';
import { ConnectorsWorkspace } from './components/ConnectorsWorkspace';
import { ConversationExportModal } from './components/ConversationExportModal';
import { DatabaseDrawer } from './components/DatabaseDrawer';
import { DeployModal } from './components/DeployModal';
import { GitHubWorkspace } from './components/GitHubWorkspace';
import { ImageWorkspace } from './components/ImageWorkspace';
import { ModelSelectorPopover } from './components/ModelSelectorPopover';
import { SettingsModal } from './components/SettingsModal';
import { ProjectWritePhase } from './components/StatusIndicator';
import {
  DEFAULT_FREE_EXTENDED_MODELS,
  DEFAULT_PROVIDERS,
  ORIGINAL_WORKBENCH_MODELS,
  SYSTEM_PROMPTS,
} from './data/models';
import { probeProviderConnection, streamChatCompletion } from './services/streaming';
import {
  BucketStatusInfo,
  ChatAttachment,
  ConnectorItem,
  Conversation,
  DbStatusInfo,
  ExternalProvider,
  GeneratedImageCard,
  GitProviderType,
  GitUser,
  LayoutMode,
  ModelOption,
  ProviderStatusInfo,
  PublicConfig,
  SyncStatusInfo,
  ThemeId,
  WorkspaceMode,
} from './types';
import {
  analyzeProjectCompleteness,
  hasUnclosedCodeFence,
  hasUnclosedThinkBlock,
  LANG_EXT_MAP,
  trimContinuationPrefix,
} from './utils/codeBlocks';
import { formatTimeShort, loadLocalJson, saveLocalJson, uid } from './utils/format';

const LS_CONVS = 'bcai.convs.v3';
const LS_ACTIVE = 'bcai.active.v3';
const LS_PROVIDERS = 'bcai.providers.v3';
const LS_SETTINGS = 'bcai.settings.v3';
const LS_GIT = 'bcai.git.v3';
const LS_THEME_DARK = 'bcai.dark.v3';
const LS_THEME_ID = 'bcai.themeId.v3';
const LS_LAYOUT_MODE = 'bcai.layoutMode.v3';
const LS_TARGET_REPO = 'bcai.targetRepo.v3';
const LS_AUTO_CONTINUE = 'bcai.autoContinue.v1';

function parseRepoSlug(urlOrSlug: string): string {
  const clean = (urlOrSlug || '').trim().replace(/\/+$/, '');
  if (!clean) return '757926525/bcai';
  try {
    const u = new URL(clean);
    return u.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '') || '757926525/bcai';
  } catch {
    return clean.replace(/^\/+|\/+$/g, '') || '757926525/bcai';
  }
}

function pickBestDefaultModel(
  targetMode: 'chat' | 'code' | 'repo',
  cfg: PublicConfig | null,
  providerList: ExternalProvider[]
): { modelId: string; providerId: string } {
  const customWorkers = providerList.find((p) => p.id === 'builtin-workers-ai');
  if (cfg?.envProviders.workersAi || (customWorkers?.accountId && customWorkers?.apiKey)) {
    return {
      modelId:
        targetMode === 'code' || targetMode === 'repo'
          ? '@cf/qwen/qwen2.5-coder-32b-instruct'
          : '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      providerId: 'builtin-workers-ai',
    };
  }
  const customGemini = providerList.find((p) => p.id === 'builtin-gemini');
  if (cfg?.envProviders.gemini || customGemini?.apiKey) {
    return { modelId: 'gemini-3.1-flash-lite', providerId: 'builtin-gemini' };
  }
  const customDeepSeek = providerList.find((p) => p.id === 'builtin-deepseek');
  if (cfg?.envProviders.deepseek || customDeepSeek?.apiKey) {
    return { modelId: 'deepseek-chat', providerId: 'builtin-deepseek' };
  }
  const customGroq = providerList.find((p) => p.id === 'builtin-groq');
  if (cfg?.envProviders.groq || customGroq?.apiKey) {
    return { modelId: 'llama-3.3-70b-versatile', providerId: 'builtin-groq' };
  }
  const customOr = providerList.find((p) => p.id === 'builtin-openrouter');
  if (cfg?.envProviders.openrouter || customOr?.apiKey) {
    return {
      modelId: targetMode === 'code' || targetMode === 'repo' ? 'qwen/qwen3-235b-a22b:free' : 'meta-llama/llama-3.3-70b-instruct:free',
      providerId: 'builtin-openrouter',
    };
  }
  if (cfg?.envProviders.openai && cfg.envProviders.openaiModels.length > 0) {
    return { modelId: cfg.envProviders.openaiModels[0], providerId: 'builtin-env-openai' };
  }
  const anyCustom = providerList.find((p) => p.enabled && p.apiKey?.trim() && p.models.length > 0);
  if (anyCustom) {
    return { modelId: anyCustom.models[0], providerId: anyCustom.id };
  }
  return {
    modelId:
      targetMode === 'code' || targetMode === 'repo'
        ? '@cf/qwen/qwen2.5-coder-32b-instruct'
        : '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    providerId: 'builtin-workers-ai',
  };
}

function createInitialConversation(
  mode: 'chat' | 'code' | 'repo' = 'code',
  repoFullName?: string,
  repoBranch?: string,
  preferred?: { modelId: string; providerId: string }
): Conversation {
  const now = new Date().toISOString();
  return {
    id: uid(),
    title: mode === 'repo' ? `仓库对话: ${repoFullName || '757926525/bcai'}` : mode === 'code' ? '新编程会话' : '新对话',
    mode,
    modelId:
      preferred?.modelId ||
      (mode === 'code' || mode === 'repo'
        ? '@cf/qwen/qwen2.5-coder-32b-instruct'
        : '@cf/meta/llama-3.3-70b-instruct-fp8-fast'),
    providerId: preferred?.providerId || 'builtin-workers-ai',
    repoFullName: mode === 'repo' ? repoFullName || '757926525/bcai' : undefined,
    repoBranch: mode === 'repo' ? repoBranch || 'main' : undefined,
    status: 'active',
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

export default function App() {
  const [dark, setDark] = useState<boolean>(() => {
    const saved = loadLocalJson<string | null>(LS_THEME_DARK, null);
    if (saved) return saved === 'dark';
    return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  });

  const [themeId, setThemeId] = useState<ThemeId>(() => loadLocalJson<ThemeId>(LS_THEME_ID, 'cf-native'));
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(() => loadLocalJson<LayoutMode>(LS_LAYOUT_MODE, 'auto'));
  const [windowWidth, setWindowWidth] = useState<number>(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1280
  );

  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const isMobileLayout = useMemo(() => {
    if (layoutMode === 'mobile') return true;
    if (layoutMode === 'desktop') return false;
    return windowWidth < 768;
  }, [layoutMode, windowWidth]);

  useEffect(() => {
    const root = document.documentElement;
    if (dark) root.classList.add('dark');
    else root.classList.remove('dark');
    saveLocalJson(LS_THEME_DARK, dark ? 'dark' : 'light');
  }, [dark]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', themeId);
    saveLocalJson(LS_THEME_ID, themeId);
  }, [themeId]);

  useEffect(() => {
    saveLocalJson(LS_LAYOUT_MODE, layoutMode);
  }, [layoutMode]);

  // Admin Session (HttpOnly/Partitioned cookie primary + synchronous in-memory ref fallback, never persisted in localStorage)
  const adminTokenRef = useRef<string>('');
  const [adminToken, setAdminToken] = useState<string>('');
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  const [authChecked, setAuthChecked] = useState<boolean>(false);

  const syncAdminToken = useCallback((token: string) => {
    adminTokenRef.current = token;
    setAdminToken(token);
  }, []);

  useEffect(() => {
    try {
      localStorage.removeItem('bcai.adminToken.v3');
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const origFetch = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('/api/')) {
        const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
        if (!headers.has('x-requested-with')) {
          headers.set('X-Requested-With', 'XMLHttpRequest');
        }
        const activeToken = adminTokenRef.current || adminToken;
        if (activeToken && !headers.has('x-admin-token')) {
          headers.set('x-admin-token', activeToken);
        }
        return origFetch(input, { ...init, headers });
      }
      return origFetch(input, init);
    };
    return () => {
      window.fetch = origFetch;
    };
  }, [adminToken]);

  const [mode, setMode] = useState<WorkspaceMode>('code');
  const [repoSubView, setRepoSubView] = useState<'browser' | 'chat'>('browser');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [conversations, setConversations] = useState<Conversation[]>(() => {
    const saved = loadLocalJson<Conversation[]>(LS_CONVS, []);
    if (saved.length === 0) return [createInitialConversation('code')];
    return saved.map((c) =>
      c.modelId === 'gemini-2.5-flash' ? { ...c, modelId: 'gemini-3.1-flash-lite' } : c
    );
  });
  const [activeId, setActiveId] = useState<string>(() => loadLocalJson<string>(LS_ACTIVE, ''));

  const activeConv = useMemo(() => {
    const found = conversations.find((c) => c.id === activeId);
    return found || conversations[0];
  }, [conversations, activeId]);

  useEffect(() => {
    if (activeConv) saveLocalJson(LS_ACTIVE, activeConv.id);
  }, [activeConv]);

  // Settings & Plan state
  const [settings, setSettings] = useState<{
    temperature: number;
    plan: 'free' | 'cloudflare' | 'pro-api';
  }>(() =>
    loadLocalJson(LS_SETTINGS, {
      temperature: 0.7,
      plan: 'free',
    })
  );

  useEffect(() => {
    saveLocalJson(LS_SETTINGS, settings);
  }, [settings]);

  const [publicConfig, setPublicConfig] = useState<PublicConfig | null>(null);

  // Target Repo URL (default https://github.com/757926525/bcai, customizable & saveable)
  const [targetRepoUrl, setTargetRepoUrl] = useState<string>(() =>
    loadLocalJson<string>(LS_TARGET_REPO, 'https://github.com/757926525/bcai')
  );

  useEffect(() => {
    saveLocalJson(LS_TARGET_REPO, targetRepoUrl);
  }, [targetRepoUrl]);

  // Providers & Real Statuses
  const [providers, setProviders] = useState<ExternalProvider[]>(() => {
    const saved = loadLocalJson<ExternalProvider[]>(LS_PROVIDERS, []);
    if (saved.length === 0) return DEFAULT_PROVIDERS;
    return saved.map((p) => {
      if (p.id === 'builtin-gemini') {
        const cleaned = p.models.filter((m) => m !== 'gemini-2.5-flash');
        if (!cleaned.includes('gemini-4-hydrogen')) cleaned.unshift('gemini-4-hydrogen');
        if (!cleaned.includes('gemini-3.1-flash-lite')) cleaned.push('gemini-3.1-flash-lite');
        return { ...p, models: cleaned };
      }
      return p;
    });
  });

  const providersRef = useRef<ExternalProvider[]>(providers);
  providersRef.current = providers;

  useEffect(() => {
    saveLocalJson(LS_PROVIDERS, providers);
  }, [providers]);

  const [providerStatuses, setProviderStatuses] = useState<Record<string, ProviderStatusInfo>>({});
  const [probingAll, setProbingAll] = useState(false);

  // DB / Bucket / Sync Real Statuses
  const [dbStatus, setDbStatus] = useState<DbStatusInfo>({
    mode: 'local-json',
    connected: false,
    d1Bound: false,
    label: '待检测',
  });
  const [bucketStatus, setBucketStatus] = useState<BucketStatusInfo>({
    configured: false,
    connected: false,
    mode: 'unconfigured',
    label: '未连接存储桶',
  });
  const [syncStatus, setSyncStatus] = useState<SyncStatusInfo>({
    status: 'idle',
    message: '尚未云端同步',
  });

  // Multi-Git state (GitHub, GitLab, Gitee)
  const [gitState, setGitState] = useState<{
    provider: GitProviderType;
    hostUrl: string;
    user: GitUser | null;
    token: string;
    repo: string;
    branch: string;
  }>(() =>
    loadLocalJson(LS_GIT, {
      provider: 'github',
      hostUrl: 'https://github.com',
      user: null,
      token: '',
      repo: '757926525/bcai',
      branch: 'main',
    })
  );

  useEffect(() => {
    saveLocalJson(LS_GIT, gitState);
  }, [gitState]);

  // Modals & Drawers
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'providers' | 'guides' | 'appearance'>('appearance');
  const [dbDrawerOpen, setDbDrawerOpen] = useState(false);
  const [deployModalOpen, setDeployModalOpen] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [pendingRepoCode, setPendingRepoCode] = useState<{ code: string; lang: string; filename?: string } | null>(null);
  const [connectors, setConnectors] = useState<ConnectorItem[]>([]);
  const [gatePw, setGatePw] = useState('');
  const [gateErr, setGateErr] = useState('');
  const [gateLoading, setGateLoading] = useState(false);
  const [toastMsg, setToastMsg] = useState<string>('');

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg((prev) => (prev === msg ? '' : prev)), 3200);
  }, []);

  // Streaming & Project Status Light control
  const [isStreaming, setIsStreaming] = useState(false);
  const [writePhase, setWritePhase] = useState<ProjectWritePhase>('idle');
  const [activeStreamModel, setActiveStreamModel] = useState<string>('');
  const [streamStartedAt, setStreamStartedAt] = useState<number | null>(null);
  const [autoContinue, setAutoContinue] = useState<boolean>(() => loadLocalJson<boolean>(LS_AUTO_CONTINUE, true));
  const [autoContinueRound, setAutoContinueRound] = useState<number>(0);
  const [completenessDetail, setCompletenessDetail] = useState<string>('');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    saveLocalJson(LS_AUTO_CONTINUE, autoContinue);
  }, [autoContinue]);

  // Debounce localStorage writes while streaming at high token throughput; flush immediately when idle
  useEffect(() => {
    if (!isStreaming) {
      saveLocalJson(LS_CONVS, conversations);
      return;
    }
    const timer = setTimeout(() => {
      saveLocalJson(LS_CONVS, conversations);
    }, 600);
    return () => clearTimeout(timer);
  }, [conversations, isStreaming]);

  useEffect(() => {
    if (!isStreaming) {
      setWritePhase('idle');
      setAutoContinueRound(0);
      setCompletenessDetail('');
      setActiveStreamModel('');
      setStreamStartedAt(null);
    }
    // Only reset status lights when switching conversations, NOT when stream finishes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const refreshConnectors = useCallback(async () => {
    if (!isAdmin) {
      setConnectors([]);
      return;
    }
    try {
      const res = await fetch('/api/connectors');
      if (res.ok) {
        const data = (await res.json()) as { items?: ConnectorItem[] };
        setConnectors(data.items || []);
      }
    } catch {
      // ignore
    }
  }, [isAdmin]);

  const refreshStorageStatuses = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const [dRes, bRes] = await Promise.all([fetch('/api/db/status'), fetch('/api/bucket/status')]);
      if (dRes.ok) {
        setDbStatus((await dRes.json()) as DbStatusInfo);
      }
      if (bRes.ok) {
        setBucketStatus((await bRes.json()) as BucketStatusInfo);
      }
    } catch {
      // ignore
    }
  }, [isAdmin]);

  const loadConfigAndAuth = useCallback(async (tokenOverride?: string) => {
    try {
      const initHeaders: Record<string, string> = {};
      if (tokenOverride) initHeaders['x-admin-token'] = tokenOverride;
      const res = await fetch('/api/config/public', tokenOverride ? { headers: initHeaders } : undefined);
      if (res.ok) {
        const cfg = (await res.json()) as PublicConfig;
        setPublicConfig(cfg);
        setIsAdmin(Boolean(cfg.isAdmin));
        if (!loadLocalJson<string | null>(LS_TARGET_REPO, null) && cfg.defaultTargetRepoUrl) {
          setTargetRepoUrl(cfg.defaultTargetRepoUrl);
        }
        if (cfg.envProviders.openai && cfg.envProviders.openaiModels.length > 0) {
          setProviders((prev) => {
            if (prev.some((p) => p.id === 'builtin-env-openai')) return prev;
            return [
              ...prev,
              {
                id: 'builtin-env-openai',
                name: '环境变量 OpenAI 兼容端点',
                providerType: 'openai-compatible',
                source: 'env',
                baseUrl: cfg.envProviders.openaiBaseUrl,
                apiKey: '',
                models: cfg.envProviders.openaiModels,
                directStream: false,
                isFreeTier: true,
                quotaNote: '后端环境变量注入',
                enabled: true,
              },
            ];
          });
        }

        // Auto-select an active configured model for empty initial conversations if Workers AI is unconfigured
        if (!cfg.envProviders.workersAi) {
          const currentProviders = providersRef.current;
          setConversations((prev) =>
            prev.map((c) => {
              if (c.messages.length === 0 && c.providerId === 'builtin-workers-ai') {
                const best = pickBestDefaultModel(c.mode, cfg, currentProviders);
                if (best.providerId !== 'builtin-workers-ai') {
                  return { ...c, modelId: best.modelId, providerId: best.providerId };
                }
              }
              return c;
            })
          );
        }
      }
    } catch {
      // ignore
    } finally {
      setAuthChecked(true);
    }
  }, []);

  useEffect(() => {
    loadConfigAndAuth();
  }, [loadConfigAndAuth]);

  useEffect(() => {
    if (!isAdmin) {
      if (mode === 'repo' || mode === 'connectors') {
        setMode('code');
      }
      return;
    }
    refreshStorageStatuses();
    refreshConnectors();
    (async () => {
      try {
        const r = await fetch(
          `/api/git/status?provider=${gitState.provider}&hostUrl=${encodeURIComponent(gitState.hostUrl)}`
        );
        if (r.ok) {
          const d = (await r.json()) as { connected: boolean; user?: GitUser };
          if (d.connected && d.user) {
            setGitState((prev) => ({ ...prev, user: d.user || prev.user }));
          }
        }
      } catch {
        // ignore
      }
    })();
  }, [isAdmin, gitState.provider, gitState.hostUrl, refreshStorageStatuses, refreshConnectors]);

  useEffect(() => {
    if (isAdmin && mode !== 'connectors') {
      refreshConnectors();
    }
  }, [isAdmin, mode, refreshConnectors]);

  // Probe single provider
  const handleProbeProvider = useCallback(async (provider: ExternalProvider) => {
    setProviderStatuses((prev) => ({
      ...prev,
      [provider.id]: { status: 'checking', message: '正在探测连接...' },
    }));
    const result = await probeProviderConnection(provider);
    setProviderStatuses((prev) => ({
      ...prev,
      [provider.id]: result,
    }));
  }, []);

  // Probe all providers honestly
  const handleProbeAll = useCallback(async () => {
    setProbingAll(true);
    try {
      await Promise.all(providers.map((p) => handleProbeProvider(p)));
    } finally {
      setProbingAll(false);
    }
  }, [providers, handleProbeProvider]);

  useEffect(() => {
    handleProbeAll();
  }, []);

  // Listen for Multi-Git OAuth popup postMessage
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const origin = event.origin;
      if (
        !origin.endsWith('.run.app') &&
        !origin.includes('localhost') &&
        origin !== window.location.origin
      ) {
        return;
      }
      const p = event.data?.provider as GitProviderType | undefined;
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS' && (p === 'github' || p === 'gitlab' || p === 'gitee')) {
        const defaultHost = p === 'gitlab' ? 'https://gitlab.com' : p === 'gitee' ? 'https://gitee.com' : 'https://github.com';
        setGitState((prev) => ({
          ...prev,
          provider: p,
          hostUrl: event.data.hostUrl || defaultHost,
          user: event.data.user || prev.user,
          token: event.data.token || prev.token,
        }));
        showToast(`${p.toUpperCase()} 已授权登录：${event.data.user?.login || '成功'}`);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [showToast]);

  // Build merged Dual-Zone Model List
  const allModels: ModelOption[] = useMemo(() => {
    const list: ModelOption[] = [...ORIGINAL_WORKBENCH_MODELS, ...DEFAULT_FREE_EXTENDED_MODELS];
    const existingKeys = new Set(list.map((m) => `${m.providerId}::${m.id}`));

    for (const p of providers) {
      if (!p.enabled) continue;
      for (const modelId of p.models) {
        const key = `${p.id}::${modelId}`;
        if (!existingKeys.has(key)) {
          existingKeys.add(key);
          list.push({
            id: modelId,
            name: modelId,
            providerId: p.id,
            providerType: p.providerType,
            zone: 'free-extended',
            isFree: p.isFreeTier,
            quotaSummary: p.quotaNote || (p.isFreeTier ? '免费额度' : '自定义端点'),
            contextWindow: 'Custom',
            streamMode:
              p.source === 'custom' &&
              p.directStream &&
              p.providerType !== 'gemini' &&
              p.providerType !== 'workers-ai'
                ? 'direct'
                : 'proxy',
          });
        } else {
          const idx = list.findIndex((m) => `${m.providerId}::${m.id}` === key);
          if (idx >= 0) {
            list[idx] = {
              ...list[idx],
              streamMode:
                p.source === 'custom' &&
                p.directStream &&
                p.providerType !== 'gemini' &&
                p.providerType !== 'workers-ai'
                  ? 'direct'
                  : 'proxy',
            };
          }
        }
      }
    }
    return list;
  }, [providers]);

  const activeModel = useMemo(
    () =>
      allModels.find((m) => m.id === activeConv?.modelId && m.providerId === activeConv?.providerId) ||
      allModels.find((m) => m.id === activeConv?.modelId) ||
      allModels[0],
    [allModels, activeConv]
  );

  // Mode switcher
  const handleSwitchMode = (nextMode: WorkspaceMode) => {
    if ((nextMode === 'repo' || nextMode === 'connectors') && !isAdmin) {
      setAuthModalOpen(true);
      showToast('仓库协同与连接器管理仅限管理员访问');
      return;
    }
    setMode(nextMode);
    if (nextMode === 'repo') {
      setRepoSubView('browser');
    }
    if (nextMode === 'code' || nextMode === 'chat' || nextMode === 'repo') {
      if (activeConv?.mode !== nextMode) {
        const match = conversations.find((c) => c.mode === nextMode);
        if (match) {
          setActiveId(match.id);
        } else {
          const created = createInitialConversation(
            nextMode,
            gitState.repo,
            gitState.branch,
            pickBestDefaultModel(nextMode, publicConfig, providers)
          );
          setConversations((prev) => [created, ...prev]);
          setActiveId(created.id);
        }
      }
    }
  };

  const handleNewConversation = (targetMode: 'chat' | 'code' = mode === 'code' ? 'code' : 'chat') => {
    if (isStreaming) return;
    if (mode !== 'code' && mode !== 'chat') setMode(targetMode);
    const created = createInitialConversation(
      targetMode,
      gitState.repo,
      gitState.branch,
      pickBestDefaultModel(targetMode, publicConfig, providers)
    );
    setConversations((prev) => [created, ...prev]);
    setActiveId(created.id);
    setSidebarOpen(false);
  };

  const handleDeleteConversation = (id: string) => {
    if (isStreaming) return;
    setConversations((prev) => {
      const filtered = prev.filter((c) => c.id !== id);
      if (filtered.length === 0) {
        const fresh = createInitialConversation(
          'code',
          undefined,
          undefined,
          pickBestDefaultModel('code', publicConfig, providers)
        );
        setActiveId(fresh.id);
        return [fresh];
      }
      if (activeId === id) {
        setActiveId(filtered[0].id);
      }
      return filtered;
    });
  };

  const handleTogglePauseSession = () => {
    if (!activeConv) return;
    if (isStreaming) {
      abortRef.current?.abort();
      return;
    }
    setConversations((prev) =>
      prev.map((c) =>
        c.id === activeConv.id
          ? {
              ...c,
              status: c.status === 'paused' ? 'active' : 'paused',
              updatedAt: new Date().toISOString(),
            }
          : c
      )
    );
  };

  const handleSelectModel = (modelId: string, providerId: string) => {
    if (!activeConv) return;
    setConversations((prev) =>
      prev.map((c) =>
        c.id === activeConv.id
          ? { ...c, modelId, providerId, updatedAt: new Date().toISOString() }
          : c
      )
    );
  };

  const buildSystemPrompt = (conv: Conversation): string => {
    let systemPrompt = SYSTEM_PROMPTS[conv.mode];
    if (conv.repoFullName) {
      systemPrompt += `\n当前关联仓库: ${conv.repoFullName}，分支: ${conv.repoBranch || 'main'}`;
    }
    if (conv.attachedFilePath && conv.attachedFileContent) {
      systemPrompt += `\n附带文件 (${conv.attachedFilePath}):\n\`\`\`\n${conv.attachedFileContent.slice(0, 18000)}\n\`\`\``;
    }
    return systemPrompt;
  };

  const MAX_AUTO_CONTINUE_ROUNDS = 6;

  const executeStream = async (
    convId: string,
    promptMessages: Array<{ role: string; content: string; attachments?: ChatAttachment[] }>,
    assistantMsgId: string,
    modelId: string,
    providerId: string,
    options?: {
      continuationDepth?: number;
      existingContent?: string;
      systemPrompt?: string;
      convMode?: 'chat' | 'code' | 'repo';
      historyBeforeAssistant?: Array<{ role: string; content: string; attachments?: ChatAttachment[] }>;
    }
  ) => {
    const provider = providersRef.current.find((p) => p.id === providerId);
    const ac = new AbortController();
    abortRef.current = ac;

    const continuationDepth = options?.continuationDepth ?? 0;
    const convMode = options?.convMode || 'code';
    let accumulated = options?.existingContent ?? '';
    const wasInsideUnclosedFence = continuationDepth > 0 && hasUnclosedCodeFence(accumulated);
    const wasInsideUnclosedThink = continuationDepth > 0 && hasUnclosedThinkBlock(accumulated);

    let prefixBuffered = continuationDepth === 0;
    let prefixBuffer = '';
    let roundAddedChars = 0;
    let willAutoContinue = false;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let writingPhaseSignaled = false;

    const flushAccumulatedToUI = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      setConversations((prev) =>
        prev.map((c) => {
          if (c.id !== convId) return c;
          return {
            ...c,
            updatedAt: new Date().toISOString(),
            messages: c.messages.map((m) =>
              m.id === assistantMsgId ? { ...m, content: accumulated } : m
            ),
          };
        })
      );
    };

    const scheduleFlush = () => {
      if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushAccumulatedToUI();
        }, 45);
      }
    };

    setIsStreaming(true);
    setAutoContinueRound(continuationDepth);
    if (continuationDepth === 0) {
      setStreamStartedAt(Date.now());
      setActiveStreamModel(modelId);
      setCompletenessDetail('');
      setWritePhase('connecting');
    } else {
      setWritePhase('continuing');
    }

    await streamChatCompletion({
      modelId,
      provider,
      messages: promptMessages,
      temperature: settings.temperature,
      signal: ac.signal,
      callbacks: {
        onMeta: (meta) => {
          if (meta.model) {
            setActiveStreamModel(meta.model);
          }
          if (meta.phase === 'fallback') {
            setWritePhase('fallback');
            if (meta.model && meta.fromModel) {
              showToast(`${meta.fromModel} 响应超时，已自动切换至 ${meta.model}`);
            }
          } else if (meta.phase === 'connecting' || meta.phase === 'thinking') {
            setWritePhase(continuationDepth > 0 ? 'continuing' : meta.phase);
          } else if (meta.phase === 'writing') {
            setWritePhase(continuationDepth > 0 ? 'continuing' : 'writing');
          } else if (meta.phase === 'truncated') {
            setWritePhase('truncated');
          }
        },
        onChunk: (delta) => {
          if (!prefixBuffered) {
            prefixBuffer += delta;
            if (prefixBuffer.length < 48 && !prefixBuffer.includes('\n')) {
              return;
            }
            const cleanStart = trimContinuationPrefix(
              accumulated,
              prefixBuffer,
              wasInsideUnclosedFence,
              wasInsideUnclosedThink
            );
            prefixBuffered = true;
            prefixBuffer = '';
            accumulated += cleanStart;
            roundAddedChars += cleanStart.length;
          } else {
            accumulated += delta;
            roundAddedChars += delta.length;
          }

          if (!writingPhaseSignaled) {
            writingPhaseSignaled = true;
            setWritePhase(continuationDepth > 0 ? 'continuing' : 'writing');
          }
          scheduleFlush();
        },
        onDone: async (result) => {
          // Flush any short un-emitted prefix buffer from continuation round
          if (!prefixBuffered && prefixBuffer) {
            const cleanStart = trimContinuationPrefix(
              accumulated,
              prefixBuffer,
              wasInsideUnclosedFence,
              wasInsideUnclosedThink
            );
            prefixBuffered = true;
            prefixBuffer = '';
            accumulated += cleanStart;
            roundAddedChars += cleanStart.length;
          }
          flushAccumulatedToUI();

          const report = analyzeProjectCompleteness(accumulated, convMode, result);
          const meaningfulProgress =
            continuationDepth === 0 || roundAddedChars >= 12 || hasUnclosedCodeFence(accumulated);

          if (
            report.incomplete &&
            autoContinue &&
            continuationDepth < MAX_AUTO_CONTINUE_ROUNDS &&
            accumulated.trim().length > 0 &&
            !ac.signal.aborted &&
            meaningfulProgress
          ) {
            willAutoContinue = true;
            const nextRound = continuationDepth + 1;
            setAutoContinueRound(nextRound);
            setCompletenessDetail(report.detail);
            setWritePhase('continuing');
            showToast(`检测到尚未完整输出（${report.detail}），正自动发起第 ${nextRound} 轮防中断续写…`);

            const tailWindow = accumulated.slice(-14000);
            const firstUserPrompt =
              options?.historyBeforeAssistant?.find((m) => m.role === 'user')?.content?.slice(0, 2000) || '';
            const filesSummary =
              report.writtenFiles.length > 0
                ? `已输出的代码文件/模块：${report.writtenFiles.join(', ')}`
                : '尚未出现完整代码块';
            const missingHint =
              report.missingFiles.length > 0
                ? `\n仍待补全的目标文件：${report.missingFiles.join(', ')}`
                : '';

            const nextMessages = [
              { role: 'system', content: options?.systemPrompt || SYSTEM_PROMPTS[convMode] },
              ...(firstUserPrompt
                ? [{ role: 'user', content: `原始完整任务需求：\n${firstUserPrompt}` }]
                : []),
              {
                role: 'assistant',
                content: `[前序已生成 ${accumulated.length} 字符。${filesSummary}]\n\n...${tailWindow}`,
              },
              {
                role: 'user',
                content:
                  `断点续写指令（第 ${nextRound} 轮）：上面回复在结尾处尚未写完（原因：${report.detail}）。${missingHint}\n` +
                  `请紧接着上面最后一行代码或正文**无缝继续输出**剩余内容：\n` +
                  `1. 若处于代码块内部，请**直接输出后续代码**并在文件写完后用 \`\`\` 闭合，切勿重复 \`\`\`lang 开头或重写已完成的代码；\n` +
                  `2. 若还有未输出的项目文件，请逐个使用 \`\`\`lang path/to/file.ext 完整写出全部剩余文件（严禁省略占位）；\n` +
                  `3. 当所有文件与说明均已完整交付时，正常结束输出即可。`,
              },
            ];

            await executeStream(
              convId,
              nextMessages,
              assistantMsgId,
              result.activeModel || modelId,
              providerId,
              {
                continuationDepth: nextRound,
                existingContent: accumulated,
                systemPrompt: options?.systemPrompt,
                convMode,
                historyBeforeAssistant: options?.historyBeforeAssistant,
              }
            );
            return;
          }

          setIsStreaming(false);
          abortRef.current = null;
          setCompletenessDetail(report.detail);
          setAutoContinueRound(continuationDepth);

          const stillIncomplete = Boolean(report.incomplete && accumulated.trim().length > 0);
          setWritePhase(stillIncomplete ? 'truncated' : 'done');

          if (accumulated.trim().length > 0) {
            if (!stillIncomplete) {
              showToast(`✅ ${report.detail}，已自动停止续写`);
            } else {
              showToast(`⚠️ ${report.detail}（可点击下方「立即续写完成」）`);
            }
          }

          setConversations((prev) =>
            prev.map((c) => {
              if (c.id !== convId) return c;
              return {
                ...c,
                updatedAt: new Date().toISOString(),
                messages: c.messages.map((m) => {
                  if (m.id !== assistantMsgId) return m;
                  if (!accumulated) {
                    return {
                      ...m,
                      interrupted: true,
                      content: '（模型未返回内容，请检查模型连接状态灯或切换模型重试）',
                    };
                  }
                  return {
                    ...m,
                    modelId: result.activeModel || m.modelId,
                    truncated: stillIncomplete,
                    interrupted: stillIncomplete ? Boolean(result.interrupted) : false,
                    paused: false,
                    completedCleanly: !stillIncomplete,
                    autoContinuedRounds: continuationDepth,
                    finishReason: result.finishReason,
                  };
                }),
              };
            })
          );
        },
        onError: (err) => {
          if (willAutoContinue) return;
          if (!prefixBuffered && prefixBuffer) {
            accumulated += prefixBuffer;
            prefixBuffer = '';
            prefixBuffered = true;
          }
          flushAccumulatedToUI();
          setIsStreaming(false);
          abortRef.current = null;
          const isAbort = err.name === 'AbortError';
          setWritePhase(isAbort ? 'paused' : 'error');
          setCompletenessDetail(isAbort ? '已手动暂停，可随时断点续写' : err.message);
          setConversations((prev) =>
            prev.map((c) => {
              if (c.id !== convId) return c;
              return {
                ...c,
                updatedAt: new Date().toISOString(),
                messages: c.messages.map((m) => {
                  if (m.id !== assistantMsgId) return m;
                  if (isAbort) {
                    return {
                      ...m,
                      paused: true,
                      autoContinuedRounds: continuationDepth,
                      content: accumulated || '（已暂停生成）',
                    };
                  }
                  return {
                    ...m,
                    interrupted: true,
                    autoContinuedRounds: continuationDepth,
                    content: `${accumulated ? accumulated + '\n\n' : ''}⚠️ ${err.message}`,
                  };
                }),
              };
            })
          );
        },
      },
    });
  };

  const handleSendMessage = async (text: string, attachments?: ChatAttachment[]) => {
    if (!activeConv || isStreaming) return;
    if (activeConv.status === 'paused') {
      showToast('当前会话已暂停，请先点击右上角“恢复会话”按钮后再发送');
      return;
    }
    const now = new Date().toISOString();
    const userMsg = {
      id: uid(),
      role: 'user' as const,
      content: text,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      createdAt: now,
    };
    const assistantMsg = {
      id: uid(),
      role: 'assistant' as const,
      content: '',
      modelId: activeConv.modelId,
      createdAt: now,
    };

    const nextMessages = [...activeConv.messages, userMsg];
    const nextTitle = activeConv.messages.length === 0 ? text.slice(0, 26) : activeConv.title;

    setConversations((prev) =>
      prev.map((c) =>
        c.id === activeConv.id
          ? {
              ...c,
              title: nextTitle,
              messages: [...nextMessages, assistantMsg],
              updatedAt: now,
            }
          : c
      )
    );

    const systemPrompt = buildSystemPrompt(activeConv);
    const historyBeforeAssistant = nextMessages.map((m) => ({
      role: m.role,
      content: m.content,
      attachments: m.attachments,
    }));
    const payloadMessages = [{ role: 'system', content: systemPrompt }, ...historyBeforeAssistant];

    await executeStream(
      activeConv.id,
      payloadMessages,
      assistantMsg.id,
      activeConv.modelId,
      activeConv.providerId,
      {
        continuationDepth: 0,
        existingContent: '',
        systemPrompt,
        convMode: activeConv.mode,
        historyBeforeAssistant,
      }
    );
  };

  const handleResumePartial = async () => {
    if (!activeConv || isStreaming) return;
    const last = activeConv.messages[activeConv.messages.length - 1];
    if (!last || last.role !== 'assistant') return;

    const cleanContent = last.content
      .replace(/^（已暂停生成）$/, '')
      .replace(/\n\n⚠️ [^\n]*$/, '')
      .trimEnd();

    const assistantMsgId = last.id;
    setConversations((prev) =>
      prev.map((c) =>
        c.id === activeConv.id
          ? {
              ...c,
              messages: c.messages.map((m) =>
                m.id === assistantMsgId
                  ? {
                      ...m,
                      content: cleanContent,
                      paused: false,
                      truncated: false,
                      interrupted: false,
                      completedCleanly: false,
                    }
                  : m
              ),
            }
          : c
      )
    );

    const systemPrompt = buildSystemPrompt(activeConv);
    const historyBeforeAssistant = activeConv.messages.slice(0, -1).map((m) => ({
      role: m.role,
      content: m.content,
      attachments: m.attachments,
    }));
    const report = analyzeProjectCompleteness(cleanContent, activeConv.mode);
    const tailWindow = cleanContent.slice(-14000);
    const firstUserPrompt =
      historyBeforeAssistant.find((m) => m.role === 'user')?.content?.slice(0, 2000) || '';
    const payloadMessages = [
      { role: 'system', content: systemPrompt },
      ...(firstUserPrompt ? [{ role: 'user', content: `原始完整任务需求：\n${firstUserPrompt}` }] : []),
      {
        role: 'assistant',
        content: `[前序已生成 ${cleanContent.length} 字符]\n\n...${tailWindow}`,
      },
      {
        role: 'user',
        content:
          `请紧接着上面最后一行无缝继续输出剩余内容（${report.detail}）。` +
          (report.missingFiles.length > 0 ? `仍待补全文件：${report.missingFiles.join(', ')}。` : '') +
          `不要重复前面已完成的代码，若当前处于未闭合代码块内部直接接续代码并在结束时用 \`\`\` 闭合。`,
      },
    ];

    await executeStream(
      activeConv.id,
      payloadMessages,
      assistantMsgId,
      activeConv.modelId,
      activeConv.providerId,
      {
        continuationDepth: (last.autoContinuedRounds || 0) + 1,
        existingContent: cleanContent,
        systemPrompt,
        convMode: activeConv.mode,
        historyBeforeAssistant,
      }
    );
  };

  // Sync Conversations to D1 & Bucket
  const handleSyncConversations = useCallback(
    async (target: 'auto' | 'd1' | 'bucket' | 'both' = 'auto') => {
      if (!isAdmin) return;
      setSyncStatus({ status: 'syncing', message: '正在同步会话历史...' });
      try {
        const res = await fetch('/api/sync/conversations', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ conversations, target }),
        });
        const data = (await res.json()) as {
          ok?: boolean;
          syncedAt?: string;
          targets?: string[];
          error?: string;
        };
        if (!res.ok) throw new Error(data.error || '同步失败');
        setSyncStatus({
          status: 'success',
          message: `已同步至 ${(data.targets || []).join(' + ') || '云端'}`,
          lastSyncedAt: data.syncedAt || new Date().toISOString(),
        });
        showToast(`历史同步成功 (${(data.targets || []).join(' + ')})`);
        refreshStorageStatuses();
      } catch (err: any) {
        setSyncStatus({
          status: 'error',
          message: err?.message || '同步失败',
        });
        showToast(err?.message || '历史同步失败');
      }
    },
    [isAdmin, conversations, showToast, refreshStorageStatuses]
  );

  const handleSaveImageToDb = async (card: GeneratedImageCard, target: 'db' | 'bucket' = 'db') => {
    if (!isAdmin) {
      showToast('请先登录管理员再保存资产');
      return;
    }
    const filename = `image-${card.createdAt.slice(0, 10)}-${card.id.slice(0, 4)}.png`;
    if (target === 'bucket') {
      const res = await fetch('/api/bucket/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: filename,
          mimeType: 'image/png',
          type: 'image',
          prompt: card.finalPrompt,
          modelId: card.modelId,
          contentData: card.dataUrl || card.url,
        }),
      });
      if (res.ok) {
        showToast('图片已存至对象存储桶 (R2/S3)');
        refreshStorageStatuses();
      } else {
        showToast('保存存储桶失败，请检查存储桶连接状态灯');
      }
      return;
    }

    const res = await fetch('/api/db/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: card.id,
        type: 'image',
        name: filename,
        mimeType: 'image/png',
        prompt: card.finalPrompt,
        modelId: card.modelId,
        contentData: card.dataUrl || card.url,
      }),
    });
    if (res.ok) {
      showToast('图片已保存到数据库并记录时间');
      refreshStorageStatuses();
    } else {
      showToast('保存图片失败，请检查数据库连接');
    }
  };

  const handleSaveCodeToDb = async (code: string, lang: string, filename?: string) => {
    if (!isAdmin) return;
    const ext = LANG_EXT_MAP[(lang || '').toLowerCase()] || lang || 'txt';
    const baseName = filename ? filename.split('/').pop() || filename : `snippet-${Date.now()}.${ext}`;
    const res = await fetch('/api/db/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: uid(),
        type: 'file',
        name: baseName,
        mimeType: 'text/plain',
        modelId: activeConv?.modelId,
        contentData: code,
        repoPath: filename || activeConv?.attachedFilePath || '',
      }),
    });
    if (res.ok) {
      showToast(`代码文件 ${baseName} 已保存到数据库`);
      refreshStorageStatuses();
    } else {
      showToast('保存代码文件失败');
    }
  };

  // Login Gate & Connector Code Save Handlers
  const handleToggleLoginGate = async (enabled: boolean, initialPassword?: string) => {
    const res = await fetch('/api/auth/login-gate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled, initialPassword }),
    });
    const data = (await res.json()) as {
      ok?: boolean;
      requireLoginGate?: boolean;
      hasAdminPassword?: boolean;
      message?: string;
      error?: string;
    };
    if (!res.ok) {
      showToast(data.error || '切换全站登录门禁失败');
      throw new Error(data.error || '切换全站登录门禁失败');
    }
    setPublicConfig((prev) =>
      prev
        ? {
            ...prev,
            requireLoginGate: Boolean(data.requireLoginGate),
            hasAdminPassword: data.hasAdminPassword ?? prev.hasAdminPassword,
          }
        : prev
    );
    showToast(data.message || (enabled ? '已开启全站访问限制' : '已关闭全站访问限制'));
  };

  const handleLockGateNow = async () => {
    await fetch('/api/auth/admin-logout', { method: 'POST' });
    syncAdminToken('');
    setIsAdmin(false);
    showToast('已退出管理员会话，全站访问门禁已生效锁屏');
    await loadConfigAndAuth('');
  };

  const handleGateLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setGateErr('');
    setGateLoading(true);
    try {
      const res = await fetch('/api/auth/admin-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: gatePw }),
      });
      const data = (await res.json()) as { adminToken?: string; error?: string };
      if (!res.ok) {
        setGateErr(data.error || '管理员密码验证失败');
        return;
      }
      const nextTok = data.adminToken || '';
      syncAdminToken(nextTok);
      setIsAdmin(true);
      setGatePw('');
      setGateErr('');
      showToast('管理员已登录，工作台已解锁');
      await loadConfigAndAuth(nextTok);
    } catch {
      setGateErr('网络异常，无法连接鉴权服务');
    } finally {
      setGateLoading(false);
    }
  };

  const handleSaveCodeToConnector = async (
    connectorId: string,
    filename: string,
    targetDir: string,
    code: string,
    lang: string
  ): Promise<{ message: string }> => {
    const res = await fetch('/api/connectors/save-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        connectorId,
        filename,
        targetDir,
        code,
        lang,
        conversationTitle: activeConv?.title || '',
        connector: connectors.find((c) => c.id === connectorId),
      }),
    });
    const data = (await res.json()) as { message?: string; error?: string };
    if (!res.ok) {
      throw new Error(data.error || '写入连接器失败');
    }
    const msg = data.message || '代码已存入连接器';
    showToast(msg);
    return { message: msg };
  };

  const handleAppendLocalExchange = (userText: string, assistantText: string) => {
    if (!activeConv) return;
    const now = new Date().toISOString();
    setConversations((prev) =>
      prev.map((c) =>
        c.id === activeConv.id
          ? {
              ...c,
              title: c.messages.length === 0 ? userText.slice(0, 26) : c.title,
              updatedAt: now,
              messages: [
                ...c.messages,
                { id: uid(), role: 'user', content: userText, createdAt: now },
                { id: uid(), role: 'assistant', content: assistantText, createdAt: now },
              ],
            }
          : c
      )
    );
  };

  // Multi-Git Actions
  const handleGitOAuth = async (provider: GitProviderType, hostUrl: string) => {
    try {
      const res = await fetch(
        `/api/auth/git/url?provider=${encodeURIComponent(provider)}&hostUrl=${encodeURIComponent(hostUrl)}`
      );
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        showToast(data.error || `请先在下方填写 ${provider.toUpperCase()} OAuth Client ID/Secret 或使用 Access Token 连接`);
        setMode('repo');
        return;
      }
      window.open(data.url, 'git_oauth_popup', 'width=640,height=740');
    } catch {
      showToast(`发起 ${provider.toUpperCase()} OAuth 授权失败`);
    }
  };

  const handleGitTokenConnect = async (provider: GitProviderType, token: string, hostUrl: string) => {
    const res = await fetch('/api/git/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider, token, hostUrl }),
    });
    const data = (await res.json()) as { user?: GitUser; error?: string };
    if (!res.ok) throw new Error(data.error || 'Token 验证失败');
    setGitState((prev) => ({ ...prev, provider, hostUrl, user: data.user || null, token }));
    showToast(`${provider.toUpperCase()} 已连接：${data.user?.login}`);
  };

  const handleGitDisconnect = async (provider: GitProviderType) => {
    await fetch('/api/git/disconnect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider }),
    });
    setGitState((prev) => ({ ...prev, user: null, token: '' }));
    showToast(`已断开 ${provider.toUpperCase()} 授权连接`);
  };

  const handleStartRepoChat = (
    repo: string,
    branch: string,
    filePath?: string,
    fileContent?: string
  ) => {
    const existing = conversations.find(
      (c) => c.mode === 'repo' && c.repoFullName === repo && c.repoBranch === branch && !filePath
    );
    if (existing && !filePath) {
      setActiveId(existing.id);
      setMode('repo');
      setRepoSubView('chat');
      return;
    }
    const now = new Date().toISOString();
    const bestRepo = pickBestDefaultModel('repo', publicConfig, providers);
    const conv: Conversation = {
      id: uid(),
      title: filePath ? `${repo.split('/')[1] || repo}: ${filePath.split('/').pop()}` : `仓库: ${repo}`,
      mode: 'repo',
      modelId: activeConv?.modelId || bestRepo.modelId,
      providerId: activeConv?.providerId || bestRepo.providerId,
      repoFullName: repo,
      repoBranch: branch,
      attachedFilePath: filePath,
      attachedFileContent: fileContent,
      status: 'active',
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    setConversations((prev) => [conv, ...prev]);
    setActiveId(conv.id);
    setMode('repo');
    setRepoSubView('chat');
  };

  const handleSaveProvider = (next: ExternalProvider) => {
    setProviders((prev) => {
      const idx = prev.findIndex((p) => p.id === next.id);
      if (idx >= 0) {
        const copy = [...prev];
        copy[idx] = next;
        return copy;
      }
      return [...prev, next];
    });
    showToast(`已保存外接 API：${next.name}`);
  };

  const handleDeleteProvider = (id: string) => {
    setProviders((prev) => prev.filter((p) => p.id !== id));
    showToast('已删除外接 API');
  };

  const handleSaveTargetRepoUrl = (url: string) => {
    const clean = url.trim() || 'https://github.com/757926525/bcai';
    setTargetRepoUrl(clean);
    const slug = parseRepoSlug(clean);
    setGitState((prev) => ({ ...prev, repo: slug }));
    showToast(`已保存目标仓库地址：${clean}`);
  };

  const workersAiProvider = providers.find((p) => p.providerType === 'workers-ai');

  const cycleLayoutMode = () => {
    if (isMobileLayout) {
      setLayoutMode('desktop');
      showToast('已切换为电脑宽屏布局');
    } else {
      setLayoutMode('mobile');
      setSidebarOpen(false);
      showToast('已切换为手机触控布局');
    }
  };

  const modeTabs: Array<[WorkspaceMode, string, React.ComponentType<{ className?: string }>]> = [
    ['code', '编程区', Code2],
    ['image', '绘图区', ImageIcon],
    ['chat', '对话', MessageSquare],
    ...(isAdmin
      ? ([
          ['repo', '仓库协同', FolderGit2],
          ['connectors', '连接器', Plug],
        ] as Array<[WorkspaceMode, string, React.ComponentType<{ className?: string }>]>)
      : []),
  ];

  // Mobile-simulation outer frame when user manually picks 'mobile' on desktop
  const forcedMobileShell = layoutMode === 'mobile' && windowWidth >= 768;

  // Wait for initial publicConfig + auth state check to prevent workspace flicker when gate is enabled
  if (!authChecked) {
    return (
      <div className="min-h-dvh w-full wb-bg wb-ink flex flex-col items-center justify-center p-4">
        <div className="flex items-center gap-3 text-xs wb-muted">
          <span className="w-4 h-4 rounded-full border-2 border-blue-600 border-t-transparent animate-spin" />
          <span>正在加载工作台安全配置…</span>
        </div>
      </div>
    );
  }

  // Site-wide Admin Login Gate: block entire workspace when enabled & not admin
  if (publicConfig?.requireLoginGate && !isAdmin) {
    return (
      <div className="min-h-dvh w-full wb-bg wb-ink flex flex-col items-center justify-center p-4">
        <div className="w-full max-w-md rounded-2xl border wb-border wb-panel shadow-xl p-6 sm:p-7 space-y-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-xl wb-tint flex items-center justify-center shrink-0">
                <Lock className="w-5 h-5 wb-accent-text" />
              </div>
              <div>
                <h1 className="font-display text-lg font-bold wb-ink">BCAI 工作台 · 管理员访问门禁</h1>
                <p className="text-xs wb-muted mt-0.5">管理员已开启全站登录限制</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setDark((d) => !d)}
              className="w-9 h-9 rounded-lg border wb-border flex items-center justify-center wb-ink hover:opacity-80 shrink-0"
              aria-label="切换明暗主题"
            >
              {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>

          <div className="rounded-xl border wb-border wb-bg p-3.5 text-xs wb-muted leading-relaxed">
            当前站点已开启<strong className="wb-ink">「仅管理员可使用全部功能」</strong>保护策略。请使用后台环境变量{' '}
            <code className="font-mono">ACCESS_PASSWORD</code> 或已设置的管理员密码登录解锁。
          </div>

          <form onSubmit={handleGateLogin} className="space-y-3">
            <label className="flex flex-col gap-1.5 text-xs wb-muted">
              <span>管理员密码</span>
              <input
                type="password"
                autoFocus
                value={gatePw}
                onChange={(e) => setGatePw(e.target.value)}
                placeholder={
                  publicConfig.hasAdminPassword
                    ? '输入 ACCESS_PASSWORD 或管理员自设密码'
                    : '首次登录可直接输入并设定管理员密码'
                }
                className="h-11 px-3 rounded-lg border wb-border wb-bg wb-ink text-sm"
              />
            </label>

            {gateErr && <div className="text-xs text-red-600 dark:text-red-400">{gateErr}</div>}

            <button
              type="submit"
              disabled={gateLoading}
              className="w-full h-11 rounded-lg wb-accent text-sm font-medium inline-flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <ShieldCheck className="w-4 h-4" />
              <span>{gateLoading ? '正在验证...' : '登录管理员并进入工作台'}</span>
            </button>
          </form>
        </div>

        {toastMsg && (
          <div className="fixed bottom-4 right-4 z-50 px-4 py-2.5 rounded-lg border wb-border wb-panel shadow-lg text-xs font-medium wb-ink max-w-[90vw]">
            {toastMsg}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="h-dvh w-full wb-bg wb-ink overflow-hidden flex justify-center">
      <div
        className={`h-full w-full flex overflow-hidden transition-all ${
          forcedMobileShell
            ? 'max-w-[430px] border-x wb-border shadow-2xl relative'
            : ''
        }`}
      >
        {/* Mobile Sidebar Backdrop */}
        {sidebarOpen && (
          <div
            className={`${forcedMobileShell ? 'absolute' : 'fixed'} inset-0 z-30 bg-slate-950/45 ${
              isMobileLayout ? '' : 'hidden'
            }`}
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Left Sidebar */}
        <aside
          className={`${
            isMobileLayout
              ? `${forcedMobileShell ? 'absolute' : 'fixed'} inset-y-0 left-0 z-40 transition-transform duration-200 ${
                  sidebarOpen ? 'translate-x-0' : '-translate-x-full'
                }`
              : 'static'
          } w-[264px] shrink-0 wb-panel border-r wb-border flex flex-col`}
        >
          <div className="px-4 py-3.5 border-b wb-border flex items-center justify-between">
            <span className="font-display text-base font-bold tracking-tight wb-ink whitespace-nowrap">
              BCAI 工作台
            </span>
            {isMobileLayout && (
              <button
                type="button"
                onClick={() => setSidebarOpen(false)}
                className="p-1.5 rounded-lg wb-muted hover:bg-black/5 dark:hover:bg-white/5"
                aria-label="关闭侧边栏"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Admin Real-Time Storage & Sync Status Panel (Moved Above New Conversation for Mobile UX) */}
          {isAdmin && (
            <div className="mx-3 mt-3 p-2.5 rounded-xl border wb-border wb-bg space-y-1.5 text-[11px]">
              <div className="flex items-center justify-between gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setDbDrawerOpen(true);
                    setSidebarOpen(false);
                  }}
                  className="inline-flex items-center gap-1.5 wb-ink hover:wb-accent-text min-w-0"
                  title="查看与配置云端数据库"
                >
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      dbStatus.connected ? 'bg-emerald-600' : dbStatus.d1Bound ? 'bg-red-600' : 'bg-amber-500'
                    }`}
                  />
                  <span className="truncate">
                    数据库：{dbStatus.connected ? (dbStatus.provider ? `${dbStatus.provider}已连` : '已连通') : dbStatus.d1Bound ? '异常' : '本地回退'}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setDbDrawerOpen(true);
                    setSidebarOpen(false);
                  }}
                  className="inline-flex items-center gap-1.5 wb-ink hover:wb-accent-text min-w-0"
                  title="查看与配置对象存储桶"
                >
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      bucketStatus.connected ? 'bg-emerald-600' : bucketStatus.configured ? 'bg-red-600' : 'bg-slate-400'
                    }`}
                  />
                  <span className="truncate">
                    存储桶：{bucketStatus.connected ? '已连' : bucketStatus.configured ? '异常' : '未配置'}
                  </span>
                </button>
              </div>

              <div className="pt-1 border-t wb-border flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => handleSyncConversations('auto')}
                  className="inline-flex items-center gap-1.5 wb-ink hover:wb-accent-text"
                  title="点击立即同步全部对话到已绑定的数据库 / 存储桶"
                >
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      syncStatus.status === 'success'
                        ? 'bg-emerald-600'
                        : syncStatus.status === 'syncing'
                        ? 'bg-amber-500 animate-pulse'
                        : syncStatus.status === 'error'
                        ? 'bg-red-600'
                        : 'bg-slate-400'
                    }`}
                  />
                  <span>
                    {syncStatus.status === 'success'
                      ? '同步历史：已成功'
                      : syncStatus.status === 'syncing'
                      ? '同步历史：进行中…'
                      : syncStatus.status === 'error'
                      ? '同步历史：失败'
                      : '同步历史：点击同步'}
                  </span>
                </button>
                <span className="font-mono text-[10px] wb-muted truncate max-w-[92px]" title={targetRepoUrl}>
                  {gitState.repo.split('/')[1] || gitState.repo}
                </span>
              </div>
            </div>
          )}

          <div className="p-3 flex gap-2">
            <button
              type="button"
              onClick={() => handleNewConversation(mode === 'chat' ? 'chat' : 'code')}
              className="flex-1 h-10 px-3 rounded-lg wb-accent text-xs sm:text-sm font-medium inline-flex items-center justify-center gap-1.5 whitespace-nowrap"
            >
              <Plus className="w-4 h-4" />
              <span>新建会话</span>
            </button>
            {isAdmin && (
              <button
                type="button"
                onClick={() => setExportModalOpen(true)}
                className="h-10 w-10 rounded-lg border wb-border flex items-center justify-center wb-ink hover:opacity-80 shrink-0"
                title="合并选择对话导出为 .txt"
              >
                <Download className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Conversation History (Strictly Admin-only) */}
          {isAdmin ? (
            <div className="flex-1 overflow-y-auto px-2 space-y-1 min-h-0">
              <div className="px-2 py-1 flex items-center justify-between text-[11px] font-medium wb-muted">
                <span>历史会话 ({conversations.length})</span>
                <button
                  type="button"
                  onClick={() => setExportModalOpen(true)}
                  className="wb-accent-text hover:underline"
                >
                  合并下载 .txt
                </button>
              </div>
              {conversations.map((c) => {
                const isSelected = c.id === activeConv?.id && (mode === 'code' || mode === 'chat' || mode === 'repo');
                const modeText = c.mode === 'code' ? '编程' : c.mode === 'repo' ? '仓库' : '对话';
                return (
                  <div
                    key={c.id}
                    className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 transition-colors ${
                      isSelected ? 'wb-tint wb-ink' : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.03]'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setActiveId(c.id);
                        setMode(c.mode);
                        if (c.mode === 'repo') setRepoSubView('chat');
                        setSidebarOpen(false);
                      }}
                      className="flex-1 min-w-0 text-left"
                    >
                      <div className="text-xs sm:text-sm font-medium truncate">{c.title}</div>
                      <div className="flex items-center gap-1.5 text-[11px] wb-muted tabular-nums">
                        <span>{modeText}</span>
                        <span aria-hidden="true">·</span>
                        <span>{formatTimeShort(c.updatedAt)}</span>
                        {c.status === 'paused' && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-amber-600 dark:text-amber-400">已暂停</span>
                          </>
                        )}
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteConversation(c.id)}
                      aria-label="删除对话"
                      className="w-7 h-7 rounded flex items-center justify-center wb-muted hover:text-red-600 opacity-70 group-hover:opacity-100 shrink-0"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
              <div className="rounded-xl border wb-border wb-bg p-3 space-y-2 text-xs">
                <div className="font-semibold wb-ink">工作区快捷切换</div>
                <button
                  type="button"
                  onClick={() => {
                    handleSwitchMode('code');
                    setSidebarOpen(false);
                  }}
                  className={`w-full h-9 px-3 rounded-lg flex items-center gap-2 text-left ${
                    mode === 'code' ? 'wb-tint wb-accent-text font-medium' : 'wb-ink hover:opacity-80'
                  }`}
                >
                  <Code2 className="w-4 h-4" />
                  <span>AI 编程区</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    handleSwitchMode('image');
                    setSidebarOpen(false);
                  }}
                  className={`w-full h-9 px-3 rounded-lg flex items-center gap-2 text-left ${
                    mode === 'image' ? 'wb-tint wb-accent-text font-medium' : 'wb-ink hover:opacity-80'
                  }`}
                >
                  <ImageIcon className="w-4 h-4" />
                  <span>AI 绘图区（负向词）</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    handleSwitchMode('chat');
                    setSidebarOpen(false);
                  }}
                  className={`w-full h-9 px-3 rounded-lg flex items-center gap-2 text-left ${
                    mode === 'chat' ? 'wb-tint wb-accent-text font-medium' : 'wb-ink hover:opacity-80'
                  }`}
                >
                  <MessageSquare className="w-4 h-4" />
                  <span>多模态对话</span>
                </button>
              </div>
              <p className="text-[11px] wb-muted px-1 leading-relaxed">
                默认免登录直接使用编程、绘图与文件对话；历史对话管理、仓库协同、D1 与存储桶、外接 API 配置需管理员登录后显示。
              </p>
            </div>
          )}

          {/* Bottom Workspace Tools: Exact Order Requested */}
          <div className="p-3 border-t wb-border space-y-1">
            {isAdmin && (
              <>
                {/* 1. 仓库连接 (MOVED ABOVE 数据库与文件 D1) */}
                <button
                  type="button"
                  onClick={() => {
                    handleSwitchMode('repo');
                    setSidebarOpen(false);
                  }}
                  className={`w-full h-9 px-3 rounded-lg text-left text-xs font-medium flex items-center gap-2.5 ${
                    mode === 'repo' ? 'wb-tint wb-accent-text' : 'wb-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04]'
                  }`}
                >
                  <FolderGit2 className="w-4 h-4 wb-muted shrink-0" />
                  <span className="truncate">仓库连接 ({gitState.provider.toUpperCase()})</span>
                </button>

                {/* 2. 数据库与文件 (D1 & 存储桶) */}
                <button
                  type="button"
                  onClick={() => {
                    setDbDrawerOpen(true);
                    setSidebarOpen(false);
                  }}
                  className="w-full h-9 px-3 rounded-lg text-left text-xs font-medium wb-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04] flex items-center gap-2.5"
                >
                  <Database className="w-4 h-4 wb-muted shrink-0" />
                  <span className="truncate">数据库与文件 (D1)</span>
                </button>

                {/* 3. 连接器中心 */}
                <button
                  type="button"
                  onClick={() => {
                    handleSwitchMode('connectors');
                    setSidebarOpen(false);
                  }}
                  className={`w-full h-9 px-3 rounded-lg text-left text-xs font-medium flex items-center gap-2.5 ${
                    mode === 'connectors' ? 'wb-tint wb-accent-text' : 'wb-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04]'
                  }`}
                >
                  <Plug className="w-4 h-4 wb-muted shrink-0" />
                  <span className="truncate">连接器中心（网盘/邮箱）</span>
                </button>
              </>
            )}

            <button
              type="button"
              onClick={() => {
                setSettingsTab('appearance');
                setSettingsModalOpen(true);
                setSidebarOpen(false);
              }}
              className="w-full h-9 px-3 rounded-lg text-left text-xs font-medium wb-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04] flex items-center gap-2.5"
            >
              <Palette className="w-4 h-4 wb-muted shrink-0" />
              <span className="truncate">主题外观与布局 (6款)</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setSettingsTab('guides');
                setSettingsModalOpen(true);
                setSidebarOpen(false);
              }}
              className="w-full h-9 px-3 rounded-lg text-left text-xs font-medium wb-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04] flex items-center gap-2.5"
            >
              <BookOpen className="w-4 h-4 wb-muted shrink-0" />
              <span className="truncate">免费模型与接入指南</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setDeployModalOpen(true);
                setSidebarOpen(false);
              }}
              className="w-full h-9 px-3 rounded-lg text-left text-xs font-medium wb-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04] flex items-center gap-2.5"
            >
              <Rocket className="w-4 h-4 wb-muted shrink-0" />
              <span className="truncate">部署和使用</span>
            </button>

            {isAdmin ? (
              <button
                type="button"
                onClick={() => {
                  setSettingsTab('providers');
                  setSettingsModalOpen(true);
                  setSidebarOpen(false);
                }}
                className="w-full h-9 px-3 rounded-lg text-left text-xs font-medium wb-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04] flex items-center gap-2.5"
              >
                <Settings className="w-4 h-4 wb-muted shrink-0" />
                <span className="truncate">外接 API 与系统设置</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setAuthModalOpen(true);
                  setSidebarOpen(false);
                }}
                className="w-full h-9 px-3 rounded-lg text-left text-xs font-medium wb-accent-text wb-tint hover:opacity-90 flex items-center gap-2.5"
              >
                <Lock className="w-4 h-4 shrink-0" />
                <span className="truncate">管理员登录</span>
              </button>
            )}
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
          {/* Top Header: Mobile-friendly spacing so Sidebar & Image buttons are always visible */}
          <header className="h-14 px-2 sm:px-4 border-b wb-border wb-panel flex items-center justify-between gap-1.5 sm:gap-2 shrink-0 min-w-0">
            <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 flex-1">
              {isMobileLayout && (
                <button
                  type="button"
                  onClick={() => setSidebarOpen(true)}
                  className="w-9 h-9 rounded-lg border wb-border flex items-center justify-center shrink-0"
                  aria-label="打开侧边栏"
                >
                  <Menu className="w-4 h-4" />
                </button>
              )}

              <div className="flex items-center gap-0.5 sm:gap-1 p-1 rounded-lg wb-bg border wb-border overflow-x-auto no-scrollbar max-w-full">
                {modeTabs.map(([mKey, label, Icon]) => (
                  <button
                    key={mKey}
                    type="button"
                    onClick={() => handleSwitchMode(mKey)}
                    className={`h-8 px-2 sm:px-3 rounded-md text-xs font-medium inline-flex items-center gap-1 sm:gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                      mode === mKey ? 'wb-panel wb-ink shadow-sm' : 'wb-muted hover:wb-ink'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
              {mode !== 'image' && mode !== 'connectors' && activeConv && (
                <ModelSelectorPopover
                  models={allModels}
                  providers={providers}
                  providerStatuses={providerStatuses}
                  selectedModelId={activeConv.modelId}
                  selectedProviderId={activeConv.providerId}
                  isAdmin={isAdmin}
                  onSelect={handleSelectModel}
                  onProbeAll={handleProbeAll}
                  onOpenSettings={() => {
                    setSettingsTab('providers');
                    setSettingsModalOpen(true);
                  }}
                  probingAll={probingAll}
                />
              )}

              {/* Pause / Resume Session Button (Top-Right Corner Only) */}
              {activeConv && (mode === 'code' || mode === 'chat' || (mode === 'repo' && repoSubView === 'chat')) && (
                <button
                  type="button"
                  onClick={handleTogglePauseSession}
                  className={`h-9 sm:h-10 px-2 sm:px-2.5 rounded-lg border text-xs font-medium inline-flex items-center gap-1 whitespace-nowrap shrink-0 ${
                    isStreaming
                      ? 'border-red-500/40 bg-red-600 text-white hover:bg-red-700'
                      : activeConv.status === 'paused'
                      ? 'border-emerald-500/50 wb-tint text-emerald-700 dark:text-emerald-300'
                      : 'wb-border wb-ink hover:opacity-80'
                  }`}
                  title={isStreaming ? '停止输出并暂停会话' : activeConv.status === 'paused' ? '恢复当前会话' : '暂停当前会话'}
                >
                  {isStreaming ? (
                    <Square className="w-3.5 h-3.5" />
                  ) : activeConv.status === 'paused' ? (
                    <Play className="w-3.5 h-3.5" />
                  ) : (
                    <Pause className="w-3.5 h-3.5" />
                  )}
                  <span className="hidden sm:inline">
                    {isStreaming ? '停止' : activeConv.status === 'paused' ? '恢复会话' : '暂停会话'}
                  </span>
                </button>
              )}

              {/* Desktop-only header controls (Moved into Settings -> 主题外观与布局 on Mobile) */}
              {!isMobileLayout && (
                <>
                  <button
                    type="button"
                    onClick={cycleLayoutMode}
                    className="h-9 sm:h-10 px-2 sm:px-2.5 rounded-lg border wb-border flex items-center justify-center gap-1 wb-ink hover:opacity-80 shrink-0"
                    title="切换手机或电脑布局"
                    aria-label="切换手机或电脑布局"
                  >
                    <Smartphone className="w-4 h-4" />
                    <span className="hidden xl:inline text-xs">手机布局</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setSettingsTab('appearance');
                      setSettingsModalOpen(true);
                    }}
                    className="w-9 h-9 sm:w-10 sm:h-10 rounded-lg border wb-border hidden sm:flex items-center justify-center wb-ink hover:opacity-80 shrink-0"
                    title="选择主题配色（6款）"
                    aria-label="选择主题配色"
                  >
                    <Palette className="w-4 h-4" />
                  </button>

                  <button
                    type="button"
                    onClick={() => setDark((d) => !d)}
                    className="w-9 h-9 sm:w-10 sm:h-10 rounded-lg border wb-border flex items-center justify-center wb-ink hover:opacity-80 shrink-0"
                    aria-label="切换明暗主题"
                    title="切换明暗主题"
                  >
                    {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                  </button>
                </>
              )}

              {/* Admin Login / Profile Button */}
              <button
                type="button"
                onClick={() => setAuthModalOpen(true)}
                className={`h-9 sm:h-10 px-2 sm:px-3 rounded-lg border text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                  isAdmin ? 'border-emerald-500/50 wb-tint wb-accent-text' : 'wb-border wb-ink hover:opacity-80'
                }`}
                title="管理员登录与密码设置"
              >
                {isAdmin ? <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" /> : <Lock className="w-3.5 h-3.5" />}
                <span className="hidden sm:inline">{isAdmin ? '管理员已登录' : '管理员'}</span>
              </button>
            </div>
          </header>

          {/* Active Viewport */}
          {mode === 'image' ? (
            <ImageWorkspace
              isAdmin={isAdmin}
              bucketConnected={bucketStatus.connected}
              workersAiProvider={workersAiProvider}
              onSaveImageToDb={handleSaveImageToDb}
            />
          ) : mode === 'connectors' && isAdmin ? (
            <ConnectorsWorkspace onShowToast={showToast} />
          ) : mode === 'repo' && isAdmin && repoSubView === 'browser' ? (
            <GitHubWorkspace
              gitProvider={gitState.provider}
              gitHostUrl={gitState.hostUrl}
              gitUser={gitState.user}
              gitToken={gitState.token}
              oauthConfigured={Boolean(publicConfig?.githubOAuthConfigured)}
              oauthProviders={publicConfig?.gitOAuthProviders}
              appUrl={publicConfig?.appUrl || (typeof window !== 'undefined' ? window.location.origin : '')}
              targetRepoUrl={targetRepoUrl}
              selectedRepo={gitState.repo}
              selectedBranch={gitState.branch}
              onChangeProvider={(provider, hostUrl) => setGitState((prev) => ({ ...prev, provider, hostUrl, user: null, token: '' }))}
              onSaveTargetRepoUrl={handleSaveTargetRepoUrl}
              onChangeRepoBranch={(repo, branch) => setGitState((prev) => ({ ...prev, repo, branch }))}
              onOAuthConnect={handleGitOAuth}
              onTokenConnect={handleGitTokenConnect}
              onDisconnect={handleGitDisconnect}
              onStartRepoChat={handleStartRepoChat}
              pendingCodeToPush={pendingRepoCode}
              onClearPendingCode={() => setPendingRepoCode(null)}
            />
          ) : mode === 'repo' && isAdmin && activeConv ? (
            <div className="flex-1 flex flex-col min-h-0 min-w-0">
              <div className="px-3 sm:px-4 py-1.5 wb-panel border-b wb-border flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="wb-muted truncate">
                  仓库协同：<code className="font-mono">{activeConv.repoFullName || gitState.repo}</code>
                </span>
                <button
                  type="button"
                  onClick={() => setRepoSubView('browser')}
                  className="wb-accent-text hover:underline font-medium whitespace-nowrap"
                >
                  打开仓库文件树与分支推送面板
                </button>
              </div>
              <ChatWorkspace
                conversation={activeConv}
                allConversations={conversations}
                activeModel={activeModel}
                providerStatus={providerStatuses[activeConv.providerId]}
                isStreaming={isStreaming}
                writePhase={writePhase}
                activeStreamModel={activeStreamModel}
                streamStartedAt={streamStartedAt}
                autoContinue={autoContinue}
                autoContinueRound={autoContinueRound}
                completenessDetail={completenessDetail}
                onToggleAutoContinue={() => setAutoContinue((v) => !v)}
                isAdmin={isAdmin}
                isMobileLayout={isMobileLayout}
                connectors={connectors}
                onSend={handleSendMessage}
                onStopStream={() => abortRef.current?.abort()}
                onTogglePauseSession={handleTogglePauseSession}
                onResumePartial={handleResumePartial}
                onClearAttachedFile={() =>
                  setConversations((prev) =>
                    prev.map((c) =>
                      c.id === activeConv.id
                        ? { ...c, attachedFilePath: undefined, attachedFileContent: undefined }
                        : c
                    )
                  )
                }
                onSaveCodeToDb={handleSaveCodeToDb}
                onSendCodeToRepo={(code, lang, filename) => {
                  setPendingRepoCode({ code, lang, filename });
                  setRepoSubView('browser');
                }}
                onSaveCodeToConnector={handleSaveCodeToConnector}
                onAppendLocalExchange={handleAppendLocalExchange}
                repoConnected={Boolean(gitState.user)}
                onOpenRepoTab={() => setRepoSubView('browser')}
                onOpenConnectorsTab={() => handleSwitchMode('connectors')}
                onOpenExportModal={() => setExportModalOpen(true)}
                onShowToast={showToast}
              />
            </div>
          ) : (
            activeConv && (
              <ChatWorkspace
                conversation={activeConv}
                allConversations={conversations}
                activeModel={activeModel}
                providerStatus={providerStatuses[activeConv.providerId]}
                isStreaming={isStreaming}
                writePhase={writePhase}
                activeStreamModel={activeStreamModel}
                streamStartedAt={streamStartedAt}
                autoContinue={autoContinue}
                autoContinueRound={autoContinueRound}
                completenessDetail={completenessDetail}
                onToggleAutoContinue={() => setAutoContinue((v) => !v)}
                isAdmin={isAdmin}
                isMobileLayout={isMobileLayout}
                connectors={connectors}
                onSend={handleSendMessage}
                onStopStream={() => abortRef.current?.abort()}
                onTogglePauseSession={handleTogglePauseSession}
                onResumePartial={handleResumePartial}
                onClearAttachedFile={() =>
                  setConversations((prev) =>
                    prev.map((c) =>
                      c.id === activeConv.id
                        ? { ...c, attachedFilePath: undefined, attachedFileContent: undefined }
                        : c
                    )
                  )
                }
                onSaveCodeToDb={handleSaveCodeToDb}
                onSendCodeToRepo={(code, lang, filename) => {
                  setPendingRepoCode({ code, lang, filename });
                  setMode('repo');
                  setRepoSubView('browser');
                }}
                onSaveCodeToConnector={handleSaveCodeToConnector}
                onAppendLocalExchange={handleAppendLocalExchange}
                repoConnected={Boolean(gitState.user)}
                onOpenRepoTab={() => {
                  setMode('repo');
                  setRepoSubView('browser');
                }}
                onOpenConnectorsTab={() => handleSwitchMode('connectors')}
                onOpenExportModal={() => setExportModalOpen(true)}
                onShowToast={showToast}
              />
            )
          )}
        </main>
      </div>

      {/* Toast Notification */}
      {toastMsg && (
        <div className="fixed bottom-4 right-4 z-50 px-4 py-2.5 rounded-lg border wb-border wb-panel shadow-lg text-xs font-medium wb-ink max-w-[90vw]">
          {toastMsg}
        </div>
      )}

      {/* Modals & Drawers */}
      <AuthPlanModal
        open={authModalOpen}
        onClose={() => setAuthModalOpen(false)}
        publicConfig={publicConfig}
        selectedPlan={settings.plan}
        onSelectPlan={(plan) => setSettings((prev) => ({ ...prev, plan }))}
        isAdmin={isAdmin}
        requireLoginGate={Boolean(publicConfig?.requireLoginGate)}
        onToggleLoginGate={handleToggleLoginGate}
        onLockGateNow={handleLockGateNow}
        onAdminLoggedIn={(token) => {
          syncAdminToken(token);
          setIsAdmin(true);
          showToast('管理员已登录，管理功能区已解锁');
          loadConfigAndAuth(token);
        }}
        onAdminLoggedOut={() => {
          syncAdminToken('');
          setIsAdmin(false);
          showToast('已退出管理员登录');
          loadConfigAndAuth('');
        }}
        onPasswordUpdated={(msg) => {
          showToast(msg);
          loadConfigAndAuth();
        }}
      />

      <SettingsModal
        open={settingsModalOpen}
        initialTab={settingsTab}
        onClose={() => setSettingsModalOpen(false)}
        isAdmin={isAdmin}
        requireLoginGate={Boolean(publicConfig?.requireLoginGate)}
        onToggleLoginGate={handleToggleLoginGate}
        onLockGateNow={handleLockGateNow}
        providers={providers}
        providerStatuses={providerStatuses}
        publicConfig={publicConfig}
        temperature={settings.temperature}
        onChangeTemperature={(temperature) => setSettings((prev) => ({ ...prev, temperature }))}
        themeId={themeId}
        onChangeTheme={(id) => {
          setThemeId(id);
          showToast('主题配色已切换');
        }}
        dark={dark}
        onToggleDark={() => setDark((d) => !d)}
        layoutMode={layoutMode}
        onChangeLayoutMode={(m) => {
          setLayoutMode(m);
          showToast(m === 'mobile' ? '已切换手机布局' : m === 'desktop' ? '已切换电脑布局' : '已切换自适应布局');
        }}
        onSaveProvider={handleSaveProvider}
        onDeleteProvider={handleDeleteProvider}
        onProbeProvider={handleProbeProvider}
        onProbeAll={handleProbeAll}
        onClearAllConversations={() => {
          const fresh = createInitialConversation(
            'code',
            undefined,
            undefined,
            pickBestDefaultModel('code', publicConfig, providers)
          );
          setConversations([fresh]);
          setActiveId(fresh.id);
          setSettingsModalOpen(false);
          showToast('已清空所有历史对话');
        }}
      />

      {isAdmin && (
        <DatabaseDrawer
          open={dbDrawerOpen}
          onClose={() => setDbDrawerOpen(false)}
          conversations={conversations}
          onRestoreConversations={(restored) => {
            setConversations(restored);
            if (restored[0]) setActiveId(restored[0].id);
          }}
          dbStatus={dbStatus}
          bucketStatus={bucketStatus}
          syncStatus={syncStatus}
          onRefreshStatuses={refreshStorageStatuses}
          onSyncConversations={handleSyncConversations}
        />
      )}

      <DeployModal
        open={deployModalOpen}
        onClose={() => setDeployModalOpen(false)}
        targetRepoUrl={targetRepoUrl}
        onSaveTargetRepoUrl={handleSaveTargetRepoUrl}
        onOpenGitHubTab={() => {
          if (!isAdmin) {
            setAuthModalOpen(true);
            showToast('请先登录管理员后进入仓库协同');
            return;
          }
          setMode('repo');
          setRepoSubView('browser');
        }}
      />

      <ConversationExportModal
        open={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        conversations={conversations}
        onExported={(name, count) => showToast(`已合并 ${count} 个会话导出为 ${name}`)}
      />
    </div>
  );
}

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
  Plug,
  Plus,
  Rocket,
  Settings,
  ShieldCheck,
  Smartphone,
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
const LS_ADMIN_TOKEN = 'bcai.adminToken.v3';

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

function createInitialConversation(
  mode: 'chat' | 'code' | 'repo' = 'code',
  repoFullName?: string,
  repoBranch?: string
): Conversation {
  const now = new Date().toISOString();
  return {
    id: uid(),
    title: mode === 'repo' ? `仓库对话: ${repoFullName || '757926525/bcai'}` : mode === 'code' ? '新编程会话' : '新对话',
    mode,
    modelId:
      mode === 'code'
        ? '@cf/qwen/qwen2.5-coder-32b-instruct'
        : '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    providerId: 'builtin-workers-ai',
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

  // Admin Session & Token Interceptor for same-origin /api/*
  const [adminToken, setAdminToken] = useState<string>(() => loadLocalJson<string>(LS_ADMIN_TOKEN, ''));
  const [isAdmin, setIsAdmin] = useState<boolean>(false);

  useEffect(() => {
    saveLocalJson(LS_ADMIN_TOKEN, adminToken);
  }, [adminToken]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const origFetch = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('/api/') && adminToken) {
        const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
        if (!headers.has('x-admin-token')) {
          headers.set('x-admin-token', adminToken);
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
    return saved.length > 0 ? saved : [createInitialConversation('code')];
  });
  const [activeId, setActiveId] = useState<string>(() => loadLocalJson<string>(LS_ACTIVE, ''));

  const activeConv = useMemo(() => {
    const found = conversations.find((c) => c.id === activeId);
    return found || conversations[0];
  }, [conversations, activeId]);

  useEffect(() => {
    saveLocalJson(LS_CONVS, conversations);
  }, [conversations]);

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
    return saved.length > 0 ? saved : DEFAULT_PROVIDERS;
  });

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
  const [pendingRepoCode, setPendingRepoCode] = useState<{ code: string; lang: string } | null>(null);
  const [toastMsg, setToastMsg] = useState<string>('');

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg((prev) => (prev === msg ? '' : prev)), 3200);
  }, []);

  // Streaming control
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

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

  const loadConfigAndAuth = useCallback(async () => {
    try {
      const res = await fetch('/api/config/public');
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
      }
    } catch {
      // ignore
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
  }, [isAdmin, gitState.provider, gitState.hostUrl, refreshStorageStatuses]);

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

  // Listen for GitHub OAuth popup postMessage
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
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS' && event.data?.provider === 'github') {
        setGitState((prev) => ({
          ...prev,
          provider: 'github',
          hostUrl: 'https://github.com',
          user: event.data.user || prev.user,
          token: event.data.token || prev.token,
        }));
        showToast(`GitHub 已授权登录：${event.data.user?.login || '成功'}`);
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
          const created = createInitialConversation(nextMode, gitState.repo, gitState.branch);
          setConversations((prev) => [created, ...prev]);
          setActiveId(created.id);
        }
      }
    }
  };

  const handleNewConversation = (targetMode: 'chat' | 'code' = mode === 'code' ? 'code' : 'chat') => {
    if (isStreaming) return;
    if (mode !== 'code' && mode !== 'chat') setMode(targetMode);
    const created = createInitialConversation(targetMode, gitState.repo, gitState.branch);
    setConversations((prev) => [created, ...prev]);
    setActiveId(created.id);
    setSidebarOpen(false);
  };

  const handleDeleteConversation = (id: string) => {
    if (isStreaming) return;
    setConversations((prev) => {
      const filtered = prev.filter((c) => c.id !== id);
      if (filtered.length === 0) {
        const fresh = createInitialConversation('code');
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

  const executeStream = async (
    convId: string,
    promptMessages: Array<{ role: string; content: string; attachments?: ChatAttachment[] }>,
    assistantMsgId: string,
    modelId: string,
    providerId: string
  ) => {
    const provider = providers.find((p) => p.id === providerId);
    const ac = new AbortController();
    abortRef.current = ac;
    setIsStreaming(true);

    await streamChatCompletion({
      modelId,
      provider,
      messages: promptMessages,
      temperature: settings.temperature,
      signal: ac.signal,
      callbacks: {
        onChunk: (delta) => {
          setConversations((prev) =>
            prev.map((c) => {
              if (c.id !== convId) return c;
              return {
                ...c,
                updatedAt: new Date().toISOString(),
                messages: c.messages.map((m) =>
                  m.id === assistantMsgId ? { ...m, content: m.content + delta } : m
                ),
              };
            })
          );
        },
        onDone: () => {
          setIsStreaming(false);
          abortRef.current = null;
          setConversations((prev) =>
            prev.map((c) => {
              if (c.id !== convId) return c;
              return {
                ...c,
                updatedAt: new Date().toISOString(),
                messages: c.messages.map((m) =>
                  m.id === assistantMsgId && !m.content
                    ? { ...m, content: '（模型未返回内容，请检查模型连接状态灯或切换模型重试）' }
                    : m
                ),
              };
            })
          );
        },
        onError: (err) => {
          setIsStreaming(false);
          abortRef.current = null;
          const isAbort = err.name === 'AbortError';
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
                      content: m.content || '（已暂停生成）',
                    };
                  }
                  return {
                    ...m,
                    content: `${m.content ? m.content + '\n\n' : ''}⚠️ ${err.message}`,
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
    if (!activeConv || isStreaming || activeConv.status === 'paused') return;
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

    let systemPrompt = SYSTEM_PROMPTS[activeConv.mode];
    if (activeConv.repoFullName) {
      systemPrompt += `\n当前关联仓库: ${activeConv.repoFullName}，分支: ${activeConv.repoBranch || 'main'}`;
    }
    if (activeConv.attachedFilePath && activeConv.attachedFileContent) {
      systemPrompt += `\n附带文件 (${activeConv.attachedFilePath}):\n\`\`\`\n${activeConv.attachedFileContent.slice(0, 18000)}\n\`\`\``;
    }

    const payloadMessages = [
      { role: 'system', content: systemPrompt },
      ...nextMessages.map((m) => ({
        role: m.role,
        content: m.content,
        attachments: m.attachments,
      })),
    ];

    await executeStream(
      activeConv.id,
      payloadMessages,
      assistantMsg.id,
      activeConv.modelId,
      activeConv.providerId
    );
  };

  const handleResumePartial = async () => {
    if (!activeConv || isStreaming) return;
    const last = activeConv.messages[activeConv.messages.length - 1];
    if (!last || last.role !== 'assistant') return;

    const assistantMsgId = last.id;
    setConversations((prev) =>
      prev.map((c) =>
        c.id === activeConv.id
          ? {
              ...c,
              messages: c.messages.map((m) => (m.id === assistantMsgId ? { ...m, paused: false } : m)),
            }
          : c
      )
    );

    const payloadMessages = [
      { role: 'system', content: SYSTEM_PROMPTS[activeConv.mode] },
      ...activeConv.messages.slice(0, -1).map((m) => ({
        role: m.role,
        content: m.content,
        attachments: m.attachments,
      })),
      { role: 'assistant', content: last.content },
      { role: 'user', content: '请紧接着上一条未完成的内容继续输出，不要重复已生成部分。' },
    ];

    await executeStream(
      activeConv.id,
      payloadMessages,
      assistantMsgId,
      activeConv.modelId,
      activeConv.providerId
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

  const handleSaveCodeToDb = async (code: string, lang: string) => {
    if (!isAdmin) return;
    const ext = lang || 'txt';
    const res = await fetch('/api/db/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: uid(),
        type: 'file',
        name: `snippet-${Date.now()}.${ext}`,
        mimeType: 'text/plain',
        modelId: activeConv?.modelId,
        contentData: code,
        repoPath: activeConv?.attachedFilePath || '',
      }),
    });
    if (res.ok) {
      showToast('代码文件已保存到数据库');
      refreshStorageStatuses();
    } else {
      showToast('保存代码文件失败');
    }
  };

  // Multi-Git Actions
  const handleGitHubOAuth = async () => {
    try {
      const res = await fetch('/api/auth/github/url');
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        showToast(data.error || '请填写 Access Token 连接仓库');
        setMode('repo');
        return;
      }
      window.open(data.url, 'github_oauth_popup', 'width=620,height=720');
    } catch {
      showToast('发起 GitHub OAuth 授权失败');
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
    const conv: Conversation = {
      id: uid(),
      title: filePath ? `${repo.split('/')[1] || repo}: ${filePath.split('/').pop()}` : `仓库: ${repo}`,
      mode: 'repo',
      modelId: activeConv?.modelId || '@cf/qwen/qwen2.5-coder-32b-instruct',
      providerId: activeConv?.providerId || 'builtin-workers-ai',
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
          {/* Top Header: Zero Mobile Edge Clipping */}
          <header className="h-14 px-2.5 sm:px-4 border-b wb-border wb-panel flex items-center justify-between gap-2 shrink-0 min-w-0">
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

              <div className="flex items-center gap-1 p-1 rounded-lg wb-bg border wb-border overflow-x-auto no-scrollbar max-w-full">
                {modeTabs.map(([mKey, label, Icon]) => (
                  <button
                    key={mKey}
                    type="button"
                    onClick={() => handleSwitchMode(mKey)}
                    className={`h-8 px-2.5 sm:px-3 rounded-md text-xs font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                      mode === mKey ? 'wb-panel wb-ink shadow-sm' : 'wb-muted hover:wb-ink'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
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

              {/* 1-Click Mobile / Desktop Layout Switch */}
              <button
                type="button"
                onClick={cycleLayoutMode}
                className="h-9 sm:h-10 px-2 sm:px-2.5 rounded-lg border wb-border flex items-center justify-center gap-1 wb-ink hover:opacity-80 shrink-0"
                title={isMobileLayout ? '切换为电脑布局' : '切换为手机布局'}
                aria-label="切换手机或电脑布局"
              >
                {isMobileLayout ? <Laptop className="w-4 h-4" /> : <Smartphone className="w-4 h-4" />}
                {!isMobileLayout && <span className="hidden xl:inline text-xs">手机布局</span>}
              </button>

              {/* Theme Picker Quick Open */}
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

              {/* Light / Dark Toggle */}
              <button
                type="button"
                onClick={() => setDark((d) => !d)}
                className="w-9 h-9 sm:w-10 sm:h-10 rounded-lg border wb-border flex items-center justify-center wb-ink hover:opacity-80 shrink-0"
                aria-label="切换明暗主题"
                title="切换明暗主题"
              >
                {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </button>

              {/* Admin Login / Profile Button */}
              <button
                type="button"
                onClick={() => setAuthModalOpen(true)}
                className={`h-9 sm:h-10 px-2.5 sm:px-3 rounded-lg border text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                  isAdmin ? 'border-emerald-500/50 wb-tint wb-accent-text' : 'wb-border wb-ink hover:opacity-80'
                }`}
                title="管理员登录与密码设置"
              >
                {isAdmin ? <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" /> : <Lock className="w-3.5 h-3.5" />}
                <span className="hidden sm:inline">{isAdmin ? '管理员已登录' : '管理员'}</span>
              </button>
            </div>
          </header>

          {/* Admin Real-Time Storage & Sync Status Lights Bar */}
          {isAdmin && (
            <div className="px-3 sm:px-4 py-1.5 border-b wb-border wb-bg flex items-center justify-between gap-3 text-[11px] overflow-x-auto no-scrollbar shrink-0">
              <div className="flex items-center gap-3 sm:gap-4 whitespace-nowrap">
                <button
                  type="button"
                  onClick={() => setDbDrawerOpen(true)}
                  className="inline-flex items-center gap-1.5 wb-ink hover:wb-accent-text"
                >
                  <span
                    className={`w-2 h-2 rounded-full ${
                      dbStatus.connected ? 'bg-emerald-600' : dbStatus.d1Bound ? 'bg-red-600' : 'bg-amber-500'
                    }`}
                  />
                  <span>数据库：{dbStatus.connected ? 'D1已连通' : dbStatus.d1Bound ? '异常' : '本地回退'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => setDbDrawerOpen(true)}
                  className="inline-flex items-center gap-1.5 wb-ink hover:wb-accent-text"
                >
                  <span
                    className={`w-2 h-2 rounded-full ${
                      bucketStatus.connected ? 'bg-emerald-600' : bucketStatus.configured ? 'bg-red-600' : 'bg-slate-400'
                    }`}
                  />
                  <span>存储桶：{bucketStatus.connected ? '已连通' : bucketStatus.configured ? '异常' : '未配置'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleSyncConversations('auto')}
                  className="inline-flex items-center gap-1.5 wb-ink hover:wb-accent-text"
                  title="点击立即同步全部对话到已绑定的 D1 / 存储桶"
                >
                  <span
                    className={`w-2 h-2 rounded-full ${
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
                      ? '历史同步成功'
                      : syncStatus.status === 'syncing'
                      ? '同步中…'
                      : syncStatus.status === 'error'
                      ? '同步失败'
                      : '点击同步历史'}
                  </span>
                </button>
              </div>

              <span className="hidden md:inline font-mono wb-muted truncate">
                目标仓库: {targetRepoUrl}
              </span>
            </div>
          )}

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
              appUrl={publicConfig?.appUrl || (typeof window !== 'undefined' ? window.location.origin : '')}
              targetRepoUrl={targetRepoUrl}
              selectedRepo={gitState.repo}
              selectedBranch={gitState.branch}
              onChangeProvider={(provider, hostUrl) => setGitState((prev) => ({ ...prev, provider, hostUrl, user: null, token: '' }))}
              onSaveTargetRepoUrl={handleSaveTargetRepoUrl}
              onChangeRepoBranch={(repo, branch) => setGitState((prev) => ({ ...prev, repo, branch }))}
              onOAuthConnect={handleGitHubOAuth}
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
                isAdmin={isAdmin}
                isMobileLayout={isMobileLayout}
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
                onSendCodeToRepo={(code, lang) => {
                  setPendingRepoCode({ code, lang });
                  setRepoSubView('browser');
                }}
                repoConnected={Boolean(gitState.user)}
                onOpenRepoTab={() => setRepoSubView('browser')}
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
                isAdmin={isAdmin}
                isMobileLayout={isMobileLayout}
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
                onSendCodeToRepo={(code, lang) => {
                  setPendingRepoCode({ code, lang });
                  setMode('repo');
                  setRepoSubView('browser');
                }}
                repoConnected={Boolean(gitState.user)}
                onOpenRepoTab={() => {
                  setMode('repo');
                  setRepoSubView('browser');
                }}
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
        onAdminLoggedIn={(token) => {
          setAdminToken(token);
          setIsAdmin(true);
          showToast('管理员已登录，管理功能区已解锁');
          loadConfigAndAuth();
        }}
        onAdminLoggedOut={() => {
          setAdminToken('');
          setIsAdmin(false);
          showToast('已退出管理员登录');
          loadConfigAndAuth();
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
          const fresh = createInitialConversation('code');
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

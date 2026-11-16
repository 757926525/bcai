import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Code2,
  Database,
  FolderGit2,
  Image as ImageIcon,
  Menu,
  MessageSquare,
  Moon,
  Plus,
  Rocket,
  Settings,
  Sun,
  Trash2,
  UserCheck,
  X,
} from 'lucide-react';
import { AuthPlanModal } from './components/AuthPlanModal';
import { ChatWorkspace } from './components/ChatWorkspace';
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
  Conversation,
  ExternalProvider,
  GeneratedImageCard,
  GitHubUser,
  ModelOption,
  ProviderStatusInfo,
  PublicConfig,
  WorkspaceMode,
} from './types';
import { formatTimeShort, loadLocalJson, saveLocalJson, uid } from './utils/format';

const LS_CONVS = 'aimx.convs.v2';
const LS_ACTIVE = 'aimx.active.v2';
const LS_PROVIDERS = 'aimx.providers.v2';
const LS_SETTINGS = 'aimx.settings.v2';
const LS_GITHUB = 'aimx.github.v2';
const LS_THEME = 'aimx.theme.v2';

function createInitialConversation(
  mode: 'chat' | 'code' | 'repo' = 'chat',
  repoFullName?: string,
  repoBranch?: string
): Conversation {
  const now = new Date().toISOString();
  return {
    id: uid(),
    title: mode === 'repo' ? `仓库对话: ${repoFullName || '757926525/aimx'}` : '新对话',
    mode,
    modelId:
      mode === 'code'
        ? '@cf/qwen/qwen2.5-coder-32b-instruct'
        : '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    providerId: 'builtin-workers-ai',
    repoFullName: mode === 'repo' ? repoFullName || '757926525/aimx' : undefined,
    repoBranch: mode === 'repo' ? repoBranch || 'main' : undefined,
    status: 'active',
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

export default function App() {
  const [dark, setDark] = useState<boolean>(() => {
    const saved = loadLocalJson<string | null>(LS_THEME, null);
    if (saved) return saved === 'dark';
    return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  });

  useEffect(() => {
    const root = document.documentElement;
    if (dark) root.classList.add('dark');
    else root.classList.remove('dark');
    saveLocalJson(LS_THEME, dark ? 'dark' : 'light');
  }, [dark]);

  const [mode, setMode] = useState<WorkspaceMode>('chat');
  const [repoSubView, setRepoSubView] = useState<'browser' | 'chat'>('browser');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [conversations, setConversations] = useState<Conversation[]>(() => {
    const saved = loadLocalJson<Conversation[]>(LS_CONVS, []);
    return saved.length > 0 ? saved : [createInitialConversation('chat')];
  });
  const [activeId, setActiveId] = useState<string>(() => {
    const savedId = loadLocalJson<string>(LS_ACTIVE, '');
    return savedId || '';
  });

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

  // Settings & Plan/Auth state
  const [settings, setSettings] = useState<{
    password: string;
    temperature: number;
    plan: 'free' | 'cloudflare' | 'pro-api';
  }>(() =>
    loadLocalJson(LS_SETTINGS, {
      password: '',
      temperature: 0.7,
      plan: 'free',
    })
  );

  useEffect(() => {
    saveLocalJson(LS_SETTINGS, settings);
  }, [settings]);

  const [publicConfig, setPublicConfig] = useState<PublicConfig | null>(null);
  const [unlocked, setUnlocked] = useState(true);

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

  // GitHub state
  const [githubState, setGithubState] = useState<{
    user: GitHubUser | null;
    token: string;
    repo: string;
    branch: string;
  }>(() =>
    loadLocalJson(LS_GITHUB, {
      user: null,
      token: '',
      repo: '757926525/aimx',
      branch: 'main',
    })
  );

  useEffect(() => {
    saveLocalJson(LS_GITHUB, githubState);
  }, [githubState]);

  // Modals
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'providers' | 'guides'>('providers');
  const [dbDrawerOpen, setDbDrawerOpen] = useState(false);
  const [deployModalOpen, setDeployModalOpen] = useState(false);
  const [pendingRepoCode, setPendingRepoCode] = useState<{ code: string; lang: string } | null>(null);
  const [toastMsg, setToastMsg] = useState<string>('');

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg((prev) => (prev === msg ? '' : prev)), 3200);
  }, []);

  // Streaming control
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Probe single provider
  const handleProbeProvider = useCallback(
    async (provider: ExternalProvider) => {
      setProviderStatuses((prev) => ({
        ...prev,
        [provider.id]: { status: 'checking', message: '正在探测连接...' },
      }));
      const result = await probeProviderConnection(provider, settings.password);
      setProviderStatuses((prev) => ({
        ...prev,
        [provider.id]: result,
      }));
    },
    [settings.password]
  );

  // Probe all providers honestly
  const handleProbeAll = useCallback(async () => {
    setProbingAll(true);
    try {
      await Promise.all(providers.map((p) => handleProbeProvider(p)));
    } finally {
      setProbingAll(false);
    }
  }, [providers, handleProbeProvider]);

  // Initial public config & honest status probe
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch('/api/config/public');
        if (res.ok && mounted) {
          const cfg = (await res.json()) as PublicConfig;
          setPublicConfig(cfg);
          setUnlocked(cfg.unlocked);
          if (cfg.requiresPassword && !cfg.unlocked) {
            setAuthModalOpen(true);
          }
          // If backend env OPENAI_API_KEY + OPENAI_MODELS is present, ensure env provider exists
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
      // Verify GitHub saved cookie session if any
      try {
        const ghRes = await fetch('/api/github/status');
        if (ghRes.ok && mounted) {
          const gh = (await ghRes.json()) as { connected: boolean; user?: GitHubUser };
          if (gh.connected && gh.user) {
            setGithubState((prev) => ({ ...prev, user: gh.user || prev.user }));
          }
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // Probe all providers on startup once
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
        setGithubState((prev) => ({
          ...prev,
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
            name: `${modelId}`,
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
          // Update streamMode dynamically if user switched directStream or saved custom apiKey
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

  // Switch Mode
  const handleSwitchMode = (nextMode: WorkspaceMode) => {
    setMode(nextMode);
    if (nextMode === 'repo') {
      setRepoSubView('browser');
    }
    if (nextMode !== 'image') {
      const targetConvMode = nextMode;
      if (activeConv?.mode !== targetConvMode) {
        const match = conversations.find((c) => c.mode === targetConvMode);
        if (match) {
          setActiveId(match.id);
        } else {
          const created = createInitialConversation(
            targetConvMode,
            githubState.repo,
            githubState.branch
          );
          setConversations((prev) => [created, ...prev]);
          setActiveId(created.id);
        }
      }
    }
  };

  // New Conversation
  const handleNewConversation = () => {
    if (isStreaming) return;
    const convMode = mode === 'image' ? 'chat' : mode;
    if (mode === 'image') setMode('chat');
    const created = createInitialConversation(convMode, githubState.repo, githubState.branch);
    setConversations((prev) => [created, ...prev]);
    setActiveId(created.id);
    setSidebarOpen(false);
  };

  // Delete Conversation
  const handleDeleteConversation = (id: string) => {
    if (isStreaming) return;
    setConversations((prev) => {
      const filtered = prev.filter((c) => c.id !== id);
      if (filtered.length === 0) {
        const fresh = createInitialConversation('chat');
        setActiveId(fresh.id);
        return [fresh];
      }
      if (activeId === id) {
        setActiveId(filtered[0].id);
      }
      return filtered;
    });
  };

  // Toggle Pause/Resume Session
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

  // Select Model
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

  // Send / Stream Message
  const executeStream = async (convId: string, promptMessages: Array<{ role: string; content: string }>, assistantMsgId: string, modelId: string, providerId: string) => {
    const provider = providers.find((p) => p.id === providerId);
    const ac = new AbortController();
    abortRef.current = ac;
    setIsStreaming(true);

    await streamChatCompletion({
      modelId,
      provider,
      messages: promptMessages,
      temperature: settings.temperature,
      accessPassword: settings.password,
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

  const handleSendMessage = async (text: string) => {
    if (!activeConv || isStreaming || activeConv.status === 'paused') return;
    const now = new Date().toISOString();
    const userMsg = { id: uid(), role: 'user' as const, content: text, createdAt: now };
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
      ...nextMessages.map((m) => ({ role: m.role, content: m.content })),
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
      ...activeConv.messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
      {
        role: 'assistant',
        content: last.content,
      },
      {
        role: 'user',
        content: '请紧接着上一条未完成的内容继续输出，不要重复已生成部分。',
      },
    ];

    await executeStream(
      activeConv.id,
      payloadMessages,
      assistantMsgId,
      activeConv.modelId,
      activeConv.providerId
    );
  };

  // Database saving helpers
  const dbHeaders = () => {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (settings.password) h['x-access-password'] = encodeURIComponent(settings.password);
    return h;
  };

  const handleSaveImageToDb = async (card: GeneratedImageCard) => {
    const res = await fetch('/api/db/items', {
      method: 'POST',
      headers: dbHeaders(),
      body: JSON.stringify({
        id: card.id,
        type: 'image',
        name: `image-${card.createdAt.slice(0, 10)}-${card.id.slice(0, 4)}.png`,
        mimeType: 'image/png',
        prompt: card.finalPrompt,
        modelId: card.modelId,
        contentData: card.dataUrl || card.url,
      }),
    });
    if (res.ok) showToast('图片已保存到数据库并记录时间');
    else showToast('保存图片失败，请检查数据库配置');
  };

  const handleSaveCodeToDb = async (code: string, lang: string) => {
    const ext = lang || 'txt';
    const res = await fetch('/api/db/items', {
      method: 'POST',
      headers: dbHeaders(),
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
    if (res.ok) showToast('代码文件已保存到数据库');
    else showToast('保存代码文件失败');
  };

  // GitHub OAuth & PAT actions
  const handleGitHubOAuth = async () => {
    try {
      const res = await fetch('/api/auth/github/url');
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        showToast(data.error || '请前往“仓库协同”面板使用 PAT Token 连接或配置 OAuth');
        setMode('repo');
        return;
      }
      window.open(data.url, 'github_oauth_popup', 'width=620,height=720');
    } catch {
      showToast('发起 GitHub OAuth 授权失败');
    }
  };

  const handleGitHubPatConnect = async (token: string) => {
    const res = await fetch('/api/github/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const data = (await res.json()) as { user?: GitHubUser; error?: string };
    if (!res.ok) throw new Error(data.error || 'Token 验证失败');
    setGithubState((prev) => ({ ...prev, user: data.user || null, token }));
    showToast(`GitHub 已连接：${data.user?.login}`);
  };

  const handleGitHubDisconnect = async () => {
    await fetch('/api/github/disconnect', { method: 'POST' });
    setGithubState((prev) => ({ ...prev, user: null, token: '' }));
    showToast('已断开 GitHub 授权连接');
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

  const workersAiProvider = providers.find((p) => p.providerType === 'workers-ai');

  return (
    <div className="h-dvh w-full flex bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 overflow-hidden">
      {/* Mobile Sidebar Backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-slate-950/40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Left Sidebar (264px) */}
      <aside
        className={`fixed md:static inset-y-0 left-0 z-40 w-[264px] shrink-0 bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 flex flex-col transition-transform duration-200 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        }`}
      >
        <div className="px-4 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <span className="font-display text-base font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap">
            AIMX 工作台
          </span>
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            className="md:hidden p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-3">
          <button
            type="button"
            onClick={handleNewConversation}
            className="w-full h-10 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            <span>新对话</span>
          </button>
        </div>

        {/* Conversation History List */}
        <div className="flex-1 overflow-y-auto px-2 space-y-1">
          <div className="px-2 py-1 text-[11px] font-medium text-slate-400 dark:text-slate-500">
            历史会话 ({conversations.length})
          </div>
          {conversations.map((c) => {
            const isSelected = c.id === activeConv?.id && mode !== 'image';
            const modeText = c.mode === 'code' ? '编程' : c.mode === 'repo' ? '仓库' : '对话';
            return (
              <div
                key={c.id}
                className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 transition-colors ${
                  isSelected
                    ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-900 dark:text-blue-100'
                    : 'hover:bg-slate-100/80 dark:hover:bg-slate-800/60'
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
                  <div className="text-sm font-medium truncate">{c.title}</div>
                  <div className="flex items-center gap-1.5 text-[11px] text-slate-400 dark:text-slate-500 tabular-nums">
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
                  className="w-7 h-7 rounded flex items-center justify-center text-slate-400 hover:text-red-600 opacity-70 group-hover:opacity-100 shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>

        {/* Bottom Workspace Tools */}
        <div className="p-3 border-t border-slate-200 dark:border-slate-800 space-y-1.5">
          <button
            type="button"
            onClick={() => setDbDrawerOpen(true)}
            className="w-full h-9 px-3 rounded-lg text-left text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-2.5"
          >
            <Database className="w-4 h-4 text-slate-500" />
            <span>数据库与文件 (D1)</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setSettingsTab('guides');
              setSettingsModalOpen(true);
            }}
            className="w-full h-9 px-3 rounded-lg text-left text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-2.5"
          >
            <BookOpen className="w-4 h-4 text-slate-500" />
            <span>免费模型与接入指南</span>
          </button>
          <button
            type="button"
            onClick={() => setDeployModalOpen(true)}
            className="w-full h-9 px-3 rounded-lg text-left text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-2.5"
          >
            <Rocket className="w-4 h-4 text-slate-500" />
            <span>部署包与多平台部署</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setSettingsTab('providers');
              setSettingsModalOpen(true);
            }}
            className="w-full h-9 px-3 rounded-lg text-left text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-2.5"
          >
            <Settings className="w-4 h-4 text-slate-500" />
            <span>外接 API 与系统设置</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Top Header */}
        <header className="h-14 px-4 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              className="md:hidden w-9 h-9 rounded-lg border border-slate-200 dark:border-slate-800 flex items-center justify-center"
              aria-label="打开侧边栏"
            >
              <Menu className="w-4 h-4" />
            </button>

            <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800 overflow-x-auto">
              {(
                [
                  ['chat', '对话', MessageSquare],
                  ['code', '编程', Code2],
                  ['image', '绘图', ImageIcon],
                  ['repo', '仓库协同', FolderGit2],
                ] as Array<[WorkspaceMode, string, React.ComponentType<{ className?: string }>]>
              ).map(([mKey, label, Icon]) => (
                <button
                  key={mKey}
                  type="button"
                  onClick={() => handleSwitchMode(mKey)}
                  className={`h-8 px-3 rounded-md text-xs font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                    mode === mKey
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {mode !== 'image' && activeConv && (
              <ModelSelectorPopover
                models={allModels}
                providers={providers}
                providerStatuses={providerStatuses}
                selectedModelId={activeConv.modelId}
                selectedProviderId={activeConv.providerId}
                onSelect={handleSelectModel}
                onProbeAll={handleProbeAll}
                onOpenSettings={() => {
                  setSettingsTab('providers');
                  setSettingsModalOpen(true);
                }}
                probingAll={probingAll}
              />
            )}

            <button
              type="button"
              onClick={() => setDark((d) => !d)}
              className="w-10 h-10 rounded-lg border border-slate-200 dark:border-slate-800 flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 shrink-0"
              aria-label="切换明暗主题"
              title="切换明暗主题"
            >
              {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>

            <button
              type="button"
              onClick={() => setAuthModalOpen(true)}
              className="h-10 px-3 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <UserCheck className="w-4 h-4 text-blue-600 dark:text-blue-400" />
              <span className="hidden sm:inline">
                {githubState.user ? githubState.user.login : '计划与登录'}
              </span>
            </button>
          </div>
        </header>

        {/* Active Viewport */}
        {mode === 'image' ? (
          <ImageWorkspace
            accessPassword={settings.password}
            workersAiProvider={workersAiProvider}
            onSaveImageToDb={handleSaveImageToDb}
          />
        ) : mode === 'repo' && repoSubView === 'browser' ? (
          <GitHubWorkspace
            githubUser={githubState.user}
            githubToken={githubState.token}
            oauthConfigured={Boolean(publicConfig?.githubOAuthConfigured)}
            appUrl={publicConfig?.appUrl || (typeof window !== 'undefined' ? window.location.origin : '')}
            selectedRepo={githubState.repo}
            selectedBranch={githubState.branch}
            onChangeRepoBranch={(repo, branch) => setGithubState((prev) => ({ ...prev, repo, branch }))}
            onOAuthConnect={handleGitHubOAuth}
            onPatConnect={handleGitHubPatConnect}
            onDisconnect={handleGitHubDisconnect}
            onStartRepoChat={handleStartRepoChat}
            pendingCodeToPush={pendingRepoCode}
            onClearPendingCode={() => setPendingRepoCode(null)}
          />
        ) : mode === 'repo' && activeConv ? (
          <div className="flex-1 flex flex-col min-h-0">
            <div className="px-4 py-1.5 bg-slate-100 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs">
              <span className="text-slate-600 dark:text-slate-300">
                仓库协同视图：当前会话已绑定 <code className="font-mono">{activeConv.repoFullName || githubState.repo}</code>
              </span>
              <button
                type="button"
                onClick={() => setRepoSubView('browser')}
                className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
              >
                打开仓库文件浏览与分支推送面板
              </button>
            </div>
            <ChatWorkspace
              conversation={activeConv}
              activeModel={activeModel}
              providerStatus={providerStatuses[activeConv.providerId]}
              isStreaming={isStreaming}
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
              repoConnected={Boolean(githubState.user)}
              onOpenRepoTab={() => setRepoSubView('browser')}
            />
          </div>
        ) : (
          activeConv && (
            <ChatWorkspace
              conversation={activeConv}
              activeModel={activeModel}
              providerStatus={providerStatuses[activeConv.providerId]}
              isStreaming={isStreaming}
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
              repoConnected={Boolean(githubState.user)}
              onOpenRepoTab={() => {
                setMode('repo');
                setRepoSubView('browser');
              }}
            />
          )
        )}
      </main>

      {/* Toast Notification */}
      {toastMsg && (
        <div className="fixed bottom-5 right-5 z-50 px-4 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-lg text-xs font-medium text-slate-800 dark:text-slate-100">
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
        accessPassword={settings.password}
        onSavePassword={(password) => setSettings((prev) => ({ ...prev, password }))}
        unlocked={unlocked}
        onUnlocked={() => {
          setUnlocked(true);
          showToast('工作台访问已验证');
        }}
        githubUser={githubState.user}
        onGitHubOAuth={handleGitHubOAuth}
      />

      <SettingsModal
        open={settingsModalOpen}
        initialTab={settingsTab}
        onClose={() => setSettingsModalOpen(false)}
        providers={providers}
        providerStatuses={providerStatuses}
        publicConfig={publicConfig}
        temperature={settings.temperature}
        onChangeTemperature={(temperature) => setSettings((prev) => ({ ...prev, temperature }))}
        onSaveProvider={handleSaveProvider}
        onDeleteProvider={handleDeleteProvider}
        onProbeProvider={handleProbeProvider}
        onProbeAll={handleProbeAll}
        onClearAllConversations={() => {
          const fresh = createInitialConversation('chat');
          setConversations([fresh]);
          setActiveId(fresh.id);
          setSettingsModalOpen(false);
          showToast('已清空所有历史对话');
        }}
      />

      <DatabaseDrawer
        open={dbDrawerOpen}
        onClose={() => setDbDrawerOpen(false)}
        accessPassword={settings.password}
      />

      <DeployModal
        open={deployModalOpen}
        onClose={() => setDeployModalOpen(false)}
        onOpenGitHubTab={() => {
          setMode('repo');
          setRepoSubView('browser');
        }}
      />
    </div>
  );
}

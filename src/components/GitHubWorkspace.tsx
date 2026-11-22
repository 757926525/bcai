import React, { useEffect, useState } from 'react';
import {
  BookOpen,
  Check,
  Copy,
  ExternalLink,
  FileCode2,
  FolderGit2,
  GitBranch,
  Github,
  KeyRound,
  Link2,
  LogOut,
  MessageSquarePlus,
  Plus,
  RefreshCw,
  Save,
  Shield,
  UploadCloud,
} from 'lucide-react';
import { GitOAuthConfigSummary, GitProviderType, GitRepo, GitTreeItem, GitUser } from '../types';

interface GitHubWorkspaceProps {
  gitProvider: GitProviderType;
  gitHostUrl: string;
  gitUser: GitUser | null;
  gitToken: string;
  oauthConfigured: boolean;
  oauthProviders?: { github: boolean; gitlab: boolean; gitee: boolean };
  appUrl: string;
  targetRepoUrl: string;
  selectedRepo: string;
  selectedBranch: string;
  onChangeProvider: (provider: GitProviderType, hostUrl: string) => void;
  onSaveTargetRepoUrl: (url: string) => void;
  onChangeRepoBranch: (repo: string, branch: string) => void;
  onOAuthConnect: (provider: GitProviderType, hostUrl: string) => void;
  onTokenConnect: (provider: GitProviderType, token: string, hostUrl: string) => Promise<void>;
  onDisconnect: (provider: GitProviderType) => Promise<void>;
  onStartRepoChat: (repo: string, branch: string, filePath?: string, fileContent?: string) => void;
  pendingCodeToPush?: { code: string; lang: string; filename?: string } | null;
  onClearPendingCode: () => void;
}

export const GitHubWorkspace: React.FC<GitHubWorkspaceProps> = ({
  gitProvider,
  gitHostUrl,
  gitUser,
  gitToken,
  oauthConfigured,
  oauthProviders,
  appUrl,
  targetRepoUrl,
  selectedRepo,
  selectedBranch,
  onChangeProvider,
  onSaveTargetRepoUrl,
  onChangeRepoBranch,
  onOAuthConnect,
  onTokenConnect,
  onDisconnect,
  onStartRepoChat,
  pendingCodeToPush,
  onClearPendingCode,
}) => {
  const [patInput, setPatInput] = useState('');
  const [hostInput, setHostInput] = useState(gitHostUrl || 'https://gitlab.com');
  const [targetUrlInput, setTargetUrlInput] = useState(targetRepoUrl || 'https://github.com/757926525/bcai');
  const [connecting, setConnecting] = useState(false);
  const [repos, setRepos] = useState<GitRepo[]>([]);
  const [branches, setBranches] = useState<string[]>(['main']);
  const [customRepoInput, setCustomRepoInput] = useState(selectedRepo || '757926525/bcai');
  const [tree, setTree] = useState<GitTreeItem[]>([]);
  const [loadingTree, setLoadingTree] = useState(false);

  // Zone 1: Site OAuth + Site ID state
  const [siteIdInput, setSiteIdInput] = useState('');
  const [oauthClientId, setOauthClientId] = useState('');
  const [oauthClientSecret, setOauthClientSecret] = useState('');
  const [oauthConfigState, setOauthConfigState] = useState<GitOAuthConfigSummary | null>(null);
  const [showOAuthSetup, setShowOAuthSetup] = useState(false);
  const [showSiteIdGuide, setShowSiteIdGuide] = useState(false);
  const [savingOAuthCfg, setSavingOAuthCfg] = useState(false);
  const [copiedCallback, setCopiedCallback] = useState(false);

  // File editor state
  const [activeFilePath, setActiveFilePath] = useState('');
  const [fileContent, setFileContent] = useState('');
  const [fileSha, setFileSha] = useState('');
  const [commitMessage, setCommitMessage] = useState('Update via BCAI AI 工作台');
  const [newBranchName, setNewBranchName] = useState('');
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [pushing, setPushing] = useState(false);
  const [syncingProject, setSyncingProject] = useState(false);

  useEffect(() => {
    setTargetUrlInput(targetRepoUrl);
  }, [targetRepoUrl]);

  const loadOAuthConfig = async () => {
    try {
      const r = await fetch('/api/git/oauth-config');
      if (r.ok) {
        const d = (await r.json()) as GitOAuthConfigSummary;
        setOauthConfigState(d);
        if (d.siteId) setSiteIdInput(d.siteId);
        if (gitProvider === 'github') setOauthClientId(d.github?.clientId || '');
        else if (gitProvider === 'gitlab') {
          setOauthClientId(d.gitlab?.clientId || '');
          if (d.gitlab?.hostUrl) setHostInput(d.gitlab.hostUrl);
        } else {
          setOauthClientId(d.gitee?.clientId || '');
        }
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    loadOAuthConfig();
  }, [gitProvider]);

  useEffect(() => {
    if (pendingCodeToPush) {
      setFileContent(pendingCodeToPush.code);
      setFileSha('');
      const ext = pendingCodeToPush.lang || 'ts';
      setActiveFilePath(pendingCodeToPush.filename || `src/generated-${Date.now()}.${ext}`);
      setStatusMsg('已载入 AI 生成的代码片段，请确认文件路径后点击“提交并推送到分支”。');
      onClearPendingCode();
    }
  }, [pendingCodeToPush, onClearPendingCode]);

  const isCurrentProviderOAuthReady = Boolean(
    (gitProvider === 'github' && (oauthConfigState?.github?.configured || oauthProviders?.github || oauthConfigured)) ||
      (gitProvider === 'gitlab' && (oauthConfigState?.gitlab?.configured || oauthProviders?.gitlab)) ||
      (gitProvider === 'gitee' && (oauthConfigState?.gitee?.configured || oauthProviders?.gitee))
  );

  const callbackUrl = `${appUrl.replace(/\/+$/, '')}/auth/callback`;

  const gitHeaders = () => {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (gitToken) {
      h['x-git-token'] = gitToken;
      if (gitProvider === 'github') h['x-github-token'] = gitToken;
    }
    return h;
  };

  const loadRepos = async () => {
    setErrorMsg('');
    try {
      const r = await fetch(
        `/api/git/repos?provider=${gitProvider}&hostUrl=${encodeURIComponent(hostInput)}`,
        { headers: gitHeaders() }
      );
      const data = (await r.json()) as { repos?: GitRepo[]; error?: string };
      if (!r.ok) throw new Error(data.error || '加载仓库列表失败');
      setRepos(data.repos || []);
    } catch (e: any) {
      setErrorMsg(e?.message || '读取仓库失败');
    }
  };

  const loadBranchesAndTree = async (repo: string, branch: string) => {
    if (!repo) return;
    setLoadingTree(true);
    setErrorMsg('');
    try {
      const [brRes, trRes] = await Promise.all([
        fetch(
          `/api/git/branches?provider=${gitProvider}&hostUrl=${encodeURIComponent(hostInput)}&repo=${encodeURIComponent(repo)}`,
          { headers: gitHeaders() }
        ),
        fetch(
          `/api/git/tree?provider=${gitProvider}&hostUrl=${encodeURIComponent(hostInput)}&repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}`,
          { headers: gitHeaders() }
        ),
      ]);
      const brData = (await brRes.json()) as { branches?: Array<{ name: string }> };
      if (Array.isArray(brData.branches) && brData.branches.length > 0) {
        setBranches(brData.branches.map((b) => b.name));
      }
      const trData = (await trRes.json()) as { tree?: GitTreeItem[]; error?: string };
      if (trRes.ok && Array.isArray(trData.tree)) {
        setTree(trData.tree.filter((i) => i.type === 'blob').slice(0, 180));
      } else {
        setTree([]);
        const msg = trData.error || '';
        if (trRes.status === 409 || msg.toLowerCase().includes('empty')) {
          setStatusMsg(
            `仓库 ${repo} 当前为空仓库，保存 Token 后点击「推送本项目到仓库」即可自动初始化 ${branch} 分支并上传全部源码。`
          );
        } else if (msg) {
          setErrorMsg(`目录读取提示: ${msg}`);
        }
      }
    } catch (e: any) {
      setErrorMsg(e?.message || '拉取分支或目录失败');
    } finally {
      setLoadingTree(false);
    }
  };

  useEffect(() => {
    if (gitUser) loadRepos();
    else setRepos([]);
  }, [gitUser, gitProvider]);

  useEffect(() => {
    if (selectedRepo) loadBranchesAndTree(selectedRepo, selectedBranch || 'main');
  }, [selectedRepo, selectedBranch, gitUser, gitProvider]);

  const handleSaveOAuthConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingOAuthCfg(true);
    setErrorMsg('');
    setStatusMsg('');
    try {
      const r = await fetch('/api/git/oauth-config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          siteId: siteIdInput.trim(),
          provider: gitProvider,
          clientId: oauthClientId.trim(),
          clientSecret: oauthClientSecret.trim() || undefined,
          hostUrl: gitProvider === 'gitlab' ? hostInput.trim() : undefined,
        }),
      });
      const d = (await r.json()) as { message?: string; error?: string };
      if (!r.ok) throw new Error(d.error || '保存站点 OAuth 配置失败');
      setOauthClientSecret('');
      setStatusMsg(d.message || '已保存仓库站点 OAuth 应用与站点 ID 配置');
      await loadOAuthConfig();
    } catch (err: any) {
      setErrorMsg(err?.message || '保存失败');
    } finally {
      setSavingOAuthCfg(false);
    }
  };

  const handleOpenFile = async (path: string) => {
    setErrorMsg('');
    setStatusMsg('');
    try {
      const r = await fetch(
        `/api/git/file?provider=${gitProvider}&hostUrl=${encodeURIComponent(hostInput)}&repo=${encodeURIComponent(selectedRepo)}&branch=${encodeURIComponent(selectedBranch)}&path=${encodeURIComponent(path)}`,
        { headers: gitHeaders() }
      );
      const data = (await r.json()) as { content?: string; sha?: string; error?: string };
      if (!r.ok) throw new Error(data.error || '读取文件失败');
      setActiveFilePath(path);
      setFileContent(data.content || '');
      setFileSha(data.sha || '');
    } catch (e: any) {
      setErrorMsg(e?.message || '读取文件失败');
    }
  };

  const handleCreateBranch = async () => {
    const clean = newBranchName.trim();
    if (!clean) return;
    setErrorMsg('');
    setStatusMsg('');
    try {
      const r = await fetch('/api/git/branch', {
        method: 'POST',
        headers: gitHeaders(),
        body: JSON.stringify({
          provider: gitProvider,
          hostUrl: hostInput,
          repo: selectedRepo,
          newBranch: clean,
          fromBranch: selectedBranch,
        }),
      });
      const data = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok) throw new Error(data.error || '创建分支失败');
      setNewBranchName('');
      onChangeRepoBranch(selectedRepo, clean);
      setStatusMsg(`已从 ${selectedBranch} 创建并切换到新分支 ${clean}`);
    } catch (e: any) {
      setErrorMsg(e?.message || '创建分支失败');
    }
  };

  const handlePushFile = async () => {
    if (!activeFilePath.trim()) {
      setErrorMsg('请先选择或填写要提交的文件路径');
      return;
    }
    setPushing(true);
    setErrorMsg('');
    setStatusMsg('');
    try {
      const r = await fetch('/api/git/file', {
        method: 'PUT',
        headers: gitHeaders(),
        body: JSON.stringify({
          provider: gitProvider,
          hostUrl: hostInput,
          repo: selectedRepo,
          branch: selectedBranch,
          path: activeFilePath.trim(),
          content: fileContent,
          message: commitMessage.trim() || `Update ${activeFilePath}`,
          sha: fileSha || undefined,
        }),
      });
      const data = (await r.json()) as { ok?: boolean; error?: string; content?: { sha?: string } };
      if (!r.ok) throw new Error(data.error || '提交推送失败');
      if (data.content?.sha) setFileSha(data.content.sha);
      setStatusMsg(`已成功提交并推送 ${activeFilePath} 到 ${selectedRepo}@${selectedBranch}`);
      loadBranchesAndTree(selectedRepo, selectedBranch);
    } catch (e: any) {
      setErrorMsg(e?.message || '推送失败');
    } finally {
      setPushing(false);
    }
  };

  const handleSyncFullProject = async () => {
    setSyncingProject(true);
    setErrorMsg('');
    setStatusMsg('');
    try {
      const headers = gitHeaders();
      const inlineToken = patInput.trim();
      if (!gitToken && inlineToken) {
        headers['x-git-token'] = inlineToken;
        if (gitProvider === 'github') headers['x-github-token'] = inlineToken;
      }
      const r = await fetch('/api/git/sync-project', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          provider: gitProvider,
          hostUrl: hostInput,
          repo: selectedRepo || '757926525/bcai',
          branch: selectedBranch || 'main',
          commitMessage: 'feat: BCAI AI Workbench full-stack update',
        }),
      });
      const data = (await r.json()) as {
        pushedCount?: number;
        total?: number;
        commitSha?: string;
        errors?: string[];
        error?: string;
      };
      if (!r.ok) throw new Error(data.error || '同步项目失败');
      if (!gitUser && inlineToken) {
        await onTokenConnect(gitProvider, inlineToken, hostInput);
        setPatInput('');
      }
      setStatusMsg(
        `已成功推送 ${data.pushedCount}/${data.total} 个文件到 [${gitProvider.toUpperCase()}] ${selectedRepo}@${selectedBranch}${data.commitSha ? ` (${data.commitSha.slice(0, 7)})` : ''}`
      );
      loadBranchesAndTree(selectedRepo, selectedBranch);
    } catch (e: any) {
      setErrorMsg(e?.message || '项目同步失败');
    } finally {
      setSyncingProject(false);
    }
  };

  const handlePatSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!patInput.trim()) return;
    setConnecting(true);
    setErrorMsg('');
    try {
      await onTokenConnect(gitProvider, patInput.trim(), hostInput);
      setPatInput('');
    } catch (err: any) {
      setErrorMsg(err?.message || 'Token 验证失败');
    } finally {
      setConnecting(false);
    }
  };

  const handleSaveCustomTarget = () => {
    const clean = targetUrlInput.trim() || 'https://github.com/757926525/bcai';
    onSaveTargetRepoUrl(clean);
    try {
      const u = new URL(clean);
      const slug = u.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
      if (slug) {
        setCustomRepoInput(slug);
        onChangeRepoBranch(slug, selectedBranch);
      }
      if (u.hostname.includes('gitlab')) onChangeProvider('gitlab', u.origin);
      else if (u.hostname.includes('gitee')) onChangeProvider('gitee', 'https://gitee.com');
      else onChangeProvider('github', 'https://github.com');
    } catch {
      setCustomRepoInput(clean);
      onChangeRepoBranch(clean, selectedBranch);
    }
    setStatusMsg(`已保存自定义目标仓库：${clean}`);
  };

  return (
    <div className="flex-1 overflow-y-auto px-3 sm:px-5 py-4 sm:py-6">
      <div className="max-w-6xl mx-auto space-y-5">
        {/* Top Connection Card: Two Clearly Divided Zones */}
        <div className="rounded-xl border wb-border wb-panel p-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 rounded-lg wb-code flex items-center justify-center shrink-0">
                <Github className="w-5 h-5 wb-ink" />
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-semibold wb-ink">
                  多平台仓库授权与分支读写协同（GitHub · GitLab · Gitee）
                </h2>
                <p className="text-xs wb-muted">
                  {gitUser
                    ? `已连接 [${gitProvider.toUpperCase()}]：${gitUser.login}${siteIdInput ? ` · 站点 ID: ${siteIdInput}` : ''}`
                    : `当前未连接 ${gitProvider.toUpperCase()}，支持「方式一：OAuth 站点授权」或「方式二：目标仓库地址 + Token 直连」`}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 p-1 rounded-lg wb-bg border wb-border">
              {(['github', 'gitlab', 'gitee'] as GitProviderType[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => onChangeProvider(p, p === 'gitlab' ? hostInput : p === 'gitee' ? 'https://gitee.com' : 'https://github.com')}
                  className={`h-8 px-3 rounded-md text-xs font-medium uppercase transition-colors ${
                    gitProvider === p ? 'wb-panel wb-ink shadow-sm' : 'wb-muted'
                  }`}
                >
                  {p === 'github' ? 'GitHub' : p === 'gitlab' ? 'GitLab / 自建' : 'Gitee 码云'}
                </button>
              ))}
            </div>
          </div>

          {/* ================= ZONE 1: 连接仓库站点（OAuth 授权与仓库站点 ID） ================= */}
          <div className="rounded-xl border wb-border wb-bg p-3.5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="px-2 py-0.5 rounded bg-blue-600 text-white text-[11px] font-semibold">
                  区域一
                </span>
                <h3 className="text-sm font-semibold wb-ink">
                  连接仓库站点（{gitProvider.toUpperCase()} OAuth 授权登录 &amp; 仓库站点 ID）
                </h3>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowSiteIdGuide((v) => !v)}
                  className="h-8 px-2.5 rounded-lg border wb-border wb-panel text-xs wb-accent-text inline-flex items-center gap-1"
                >
                  <BookOpen className="w-3.5 h-3.5" />
                  <span>{showSiteIdGuide ? '收起站点 ID 说明' : '仓库站点 ID 部署与使用说明'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowOAuthSetup((v) => !v)}
                  className="h-8 px-2.5 rounded-lg border wb-border wb-panel text-xs wb-ink inline-flex items-center gap-1"
                >
                  <Shield className="w-3.5 h-3.5" />
                  <span>{showOAuthSetup ? '收起 OAuth 参数配置' : '配置 OAuth 站点凭证'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onOAuthConnect(gitProvider, hostInput)}
                  className="h-8 px-3.5 rounded-lg wb-accent text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>
                    {isCurrentProviderOAuthReady ? `OAuth 一键授权 ${gitProvider.toUpperCase()}` : `发起 ${gitProvider.toUpperCase()} OAuth 授权`}
                  </span>
                </button>
                {gitUser && (
                  <button
                    type="button"
                    onClick={() => onDisconnect(gitProvider)}
                    className="h-8 px-2.5 rounded-lg border wb-border wb-panel text-xs text-red-600 dark:text-red-400 inline-flex items-center gap-1"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    <span>断开连接</span>
                  </button>
                )}
              </div>
            </div>

            {showSiteIdGuide && (
              <div className="rounded-lg border wb-border wb-panel p-3.5 text-xs space-y-2 leading-relaxed">
                <div className="font-semibold wb-ink">仓库站点 ID（OAuth App ID / 云部署站点 ID）部署与使用说明：</div>
                <ol className="list-decimal pl-5 space-y-1.5 wb-muted">
                  <li>
                    <strong className="wb-ink">什么是仓库站点 ID？</strong>
                    包含两类标识：(1) GitHub / GitLab / Gitee 第三方 OAuth 应用的 <code className="font-mono">Client ID / Application ID</code>；(2) 部署在腾讯云 EdgeOne、阿里云 ESA、Cloudflare Pages 或 Netlify 时平台分配的 <strong className="wb-ink">Site ID / Project ID</strong>，用于绑定当前工作台与外部部署站点。
                  </li>
                  <li>
                    <strong className="wb-ink">创建 OAuth 应用回调地址：</strong>
                    在 GitHub（Developer Settings → OAuth Apps）、GitLab（User Settings → Applications）或 Gitee（第三方应用）中，将 Authorization Callback URL 精确设为：
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <code className="px-2 py-1 rounded wb-bg border wb-border font-mono text-[11px] wb-ink break-all">
                        {callbackUrl}
                      </code>
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard?.writeText(callbackUrl);
                          setCopiedCallback(true);
                          setTimeout(() => setCopiedCallback(false), 1500);
                        }}
                        className="px-2 py-1 rounded border wb-border text-[11px] wb-ink inline-flex items-center gap-1"
                      >
                        {copiedCallback ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                        <span>{copiedCallback ? '已复制' : '复制回调地址'}</span>
                      </button>
                    </div>
                  </li>
                  <li>
                    <strong className="wb-ink">部署环境变量与界面持久化：</strong>
                    服务端可将 <code className="font-mono">APP_URL</code>（站点公网域名）、<code className="font-mono">GITHUB_CLIENT_ID / SECRET</code>、<code className="font-mono">GITLAB_CLIENT_ID / SECRET</code>、<code className="font-mono">GITEE_CLIENT_ID / SECRET</code> 写入环境变量；也可直接点击上方「配置 OAuth 站点凭证」在工作台内保存，立即生效无需重启。
                  </li>
                  <li>
                    <strong className="wb-ink">安全授权弹窗流程：</strong>
                    点击「OAuth 一键授权」后将弹出官方授权页面，授权完成自动回传会话令牌并保存 HttpOnly Cookie，随后即可直接读写仓库分支、创建分支与一键推送整库。
                  </li>
                </ol>
              </div>
            )}

            {(showOAuthSetup || !isCurrentProviderOAuthReady) && (
              <form onSubmit={handleSaveOAuthConfig} className="grid grid-cols-1 md:grid-cols-12 gap-2.5 pt-2 border-t wb-border items-end">
                <div className="md:col-span-3 flex flex-col gap-1">
                  <label className="text-[11px] wb-muted">仓库站点 ID（Site ID / 站点别名）</label>
                  <input
                    type="text"
                    value={siteIdInput}
                    onChange={(e) => setSiteIdInput(e.target.value)}
                    placeholder="如 bcai-site-01 或云站点 ID"
                    className="h-9 px-2.5 rounded-lg border wb-border wb-panel text-xs font-mono wb-ink"
                  />
                </div>
                <div className="md:col-span-3 flex flex-col gap-1">
                  <label className="text-[11px] wb-muted">{gitProvider.toUpperCase()} OAuth Client ID</label>
                  <input
                    type="text"
                    value={oauthClientId}
                    onChange={(e) => setOauthClientId(e.target.value)}
                    placeholder="填入 OAuth App Client ID"
                    className="h-9 px-2.5 rounded-lg border wb-border wb-panel text-xs font-mono wb-ink"
                  />
                </div>
                <div className="md:col-span-3 flex flex-col gap-1">
                  <label className="text-[11px] wb-muted">{gitProvider.toUpperCase()} Client Secret</label>
                  <input
                    type="password"
                    value={oauthClientSecret}
                    onChange={(e) => setOauthClientSecret(e.target.value)}
                    placeholder={isCurrentProviderOAuthReady ? '已保存（留空保留原值）' : '填入 Client Secret'}
                    className="h-9 px-2.5 rounded-lg border wb-border wb-panel text-xs font-mono wb-ink"
                  />
                </div>
                <div className="md:col-span-3 flex gap-2">
                  <button
                    type="submit"
                    disabled={savingOAuthCfg}
                    className="w-full h-9 px-3 rounded-lg border wb-border wb-panel hover:opacity-80 text-xs font-medium wb-ink whitespace-nowrap"
                  >
                    {savingOAuthCfg ? '保存中...' : '保存站点 OAuth 配置'}
                  </button>
                </div>
                <div className="md:col-span-12 text-[11px] wb-muted flex flex-wrap items-center justify-between gap-2">
                  <span>
                    当前回调 URI：<code className="font-mono">{callbackUrl}</code>
                  </span>
                  <span>
                    {isCurrentProviderOAuthReady ? '✅ OAuth 应用凭证已就绪，可直接点击上方“OAuth 一键授权”' : '尚未配置 OAuth 密钥，也可直接使用下方「区域二」保存仓库地址与 Token'}
                  </span>
                </div>
              </form>
            )}
          </div>

          {/* ================= DIVIDER BETWEEN ZONE 1 AND ZONE 2 ================= */}
          <div className="relative py-1">
            <div className="border-t-2 border-dashed wb-border" />
            <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 px-3 py-0.5 wb-panel text-[11px] font-medium wb-muted border wb-border rounded-full whitespace-nowrap">
              或直接通过下方目标仓库地址 + Token 连接
            </span>
          </div>

          {/* ================= ZONE 2: 保存目标仓库地址和 Token 实现连接 ================= */}
          <div className="rounded-xl border wb-border wb-bg p-3.5 space-y-3">
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 rounded bg-emerald-600 text-white text-[11px] font-semibold">
                区域二
              </span>
              <h3 className="text-sm font-semibold wb-ink">
                保存目标仓库地址和 Access Token 实现直连
              </h3>
            </div>

            {/* Target Repo URL */}
            <div className="grid grid-cols-1 md:grid-cols-12 gap-2.5 items-end">
              <div className="md:col-span-9 flex flex-col gap-1">
                <label className="text-xs wb-muted flex items-center gap-1">
                  <Link2 className="w-3.5 h-3.5" />
                  <span>目标开源仓库地址（默认 https://github.com/757926525/bcai，支持 GitHub / GitLab / Gitee）</span>
                </label>
                <input
                  type="text"
                  value={targetUrlInput}
                  onChange={(e) => setTargetUrlInput(e.target.value)}
                  placeholder="https://github.com/757926525/bcai"
                  className="h-9 px-3 rounded-lg border wb-border wb-panel text-xs font-mono wb-ink"
                />
              </div>
              <div className="md:col-span-3">
                <button
                  type="button"
                  onClick={handleSaveCustomTarget}
                  className="w-full h-9 px-3 rounded-lg wb-accent text-xs font-medium whitespace-nowrap"
                >
                  保存目标仓库地址
                </button>
              </div>
            </div>

            {/* PAT Token Form */}
            {!gitUser && (
              <form onSubmit={handlePatSubmit} className="flex flex-wrap items-center gap-2 pt-2 border-t wb-border">
                <KeyRound className="w-4 h-4 wb-muted shrink-0" />
                {gitProvider === 'gitlab' && (
                  <input
                    type="text"
                    value={hostInput}
                    onChange={(e) => setHostInput(e.target.value)}
                    placeholder="https://gitlab.com 或私有 GitLab 地址"
                    className="w-56 h-9 px-3 rounded-lg border wb-border wb-panel text-xs font-mono wb-ink"
                  />
                )}
                <input
                  type="password"
                  value={patInput}
                  onChange={(e) => setPatInput(e.target.value)}
                  placeholder={`输入 ${gitProvider.toUpperCase()} Personal Access Token 并保存连接`}
                  className="flex-1 min-w-[220px] h-9 px-3 rounded-lg border wb-border wb-panel text-xs wb-ink"
                />
                <button
                  type="submit"
                  disabled={connecting || !patInput.trim()}
                  className="h-9 px-4 rounded-lg wb-accent text-xs font-medium disabled:opacity-50 whitespace-nowrap"
                >
                  {connecting ? '连接中...' : '保存 Token 连接'}
                </button>
              </form>
            )}
          </div>

          {/* Repo & Branch Picker */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-3 pt-2 border-t wb-border items-end">
            <div className="md:col-span-5 flex flex-col gap-1">
              <label className="text-xs wb-muted">选择或输入仓库（owner/repo）</label>
              <div className="flex gap-2">
                {repos.length > 0 ? (
                  <select
                    value={selectedRepo}
                    onChange={(e) => {
                      const r = repos.find((x) => x.full_name === e.target.value);
                      onChangeRepoBranch(e.target.value, r?.default_branch || 'main');
                      setCustomRepoInput(e.target.value);
                    }}
                    className="flex-1 min-w-0 h-9 px-2.5 rounded-lg border wb-border wb-bg text-xs wb-ink"
                  >
                    <option value="757926525/bcai">757926525/bcai（默认 BCAI 仓库）</option>
                    {repos
                      .filter((r) => r.full_name !== '757926525/bcai')
                      .map((r) => (
                        <option key={r.id} value={r.full_name}>
                          {r.full_name} {r.private ? '(私有)' : ''}
                        </option>
                      ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={customRepoInput}
                    onChange={(e) => setCustomRepoInput(e.target.value)}
                    placeholder="757926525/bcai"
                    className="flex-1 min-w-0 h-9 px-3 rounded-lg border wb-border wb-bg text-xs font-mono wb-ink"
                  />
                )}
                <button
                  type="button"
                  onClick={() => onChangeRepoBranch(customRepoInput.trim() || selectedRepo, selectedBranch)}
                  className="h-9 px-3 rounded-lg border wb-border text-xs wb-ink hover:opacity-80 whitespace-nowrap"
                >
                  载入
                </button>
              </div>
            </div>

            <div className="md:col-span-3 flex flex-col gap-1">
              <label className="text-xs wb-muted">当前分支</label>
              <div className="flex gap-1.5">
                <select
                  value={selectedBranch}
                  onChange={(e) => onChangeRepoBranch(selectedRepo, e.target.value)}
                  className="flex-1 min-w-0 h-9 px-2.5 rounded-lg border wb-border wb-bg text-xs font-mono wb-ink"
                >
                  {branches.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => loadBranchesAndTree(selectedRepo, selectedBranch)}
                  className="h-9 w-9 rounded-lg border wb-border flex items-center justify-center hover:opacity-80 shrink-0"
                  title="刷新目录与分支"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loadingTree ? 'animate-spin' : ''}`} />
                </button>
              </div>
            </div>

            <div className="md:col-span-4 flex flex-wrap gap-2 justify-end">
              <button
                type="button"
                onClick={() => onStartRepoChat(selectedRepo, selectedBranch, activeFilePath || undefined, fileContent || undefined)}
                className="h-9 px-3.5 rounded-lg wb-accent text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                <MessageSquarePlus className="w-3.5 h-3.5" />
                <span>进入仓库分支对话</span>
              </button>
              <button
                type="button"
                onClick={handleSyncFullProject}
                disabled={syncingProject}
                className="h-9 px-3.5 rounded-lg border border-emerald-600 text-emerald-700 dark:text-emerald-400 text-xs font-medium inline-flex items-center gap-1.5 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 disabled:opacity-50 whitespace-nowrap"
              >
                <UploadCloud className="w-3.5 h-3.5" />
                <span>{syncingProject ? '推送中...' : '推送本项目到仓库'}</span>
              </button>
            </div>
          </div>

          {statusMsg && (
            <div className="px-3 py-2 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 text-xs text-emerald-800 dark:text-emerald-300 flex items-center gap-2">
              <Check className="w-4 h-4 shrink-0" />
              <span className="break-all">{statusMsg}</span>
            </div>
          )}
          {errorMsg && (
            <div className="px-3 py-2 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-400 break-all">
              {errorMsg}
            </div>
          )}
        </div>

        {/* File Tree & Editor Split */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="lg:col-span-4 rounded-xl border wb-border wb-panel flex flex-col max-h-[540px]">
            <div className="px-3.5 py-2.5 border-b wb-border flex items-center justify-between">
              <span className="text-xs font-semibold wb-ink inline-flex items-center gap-1.5">
                <FolderGit2 className="w-4 h-4 wb-muted" />
                <span>仓库文件树 ({tree.length})</span>
              </span>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
              {tree.length === 0 ? (
                <p className="text-xs wb-muted p-3 text-center">
                  {loadingTree ? '正在加载目录树…' : '暂无文件记录或该分支尚未初始化。'}
                </p>
              ) : (
                tree.map((item) => (
                  <button
                    key={item.path}
                    type="button"
                    onClick={() => handleOpenFile(item.path)}
                    className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-mono truncate flex items-center gap-2 ${
                      activeFilePath === item.path ? 'wb-tint wb-accent-text font-medium' : 'wb-ink hover:opacity-80'
                    }`}
                  >
                    <FileCode2 className="w-3.5 h-3.5 shrink-0 wb-muted" />
                    <span className="truncate">{item.path}</span>
                  </button>
                ))
              )}
            </div>
            {gitUser && (
              <div className="p-2.5 border-t wb-border flex gap-1.5">
                <input
                  type="text"
                  value={newBranchName}
                  onChange={(e) => setNewBranchName(e.target.value)}
                  placeholder="新分支名 (如 feat/ui)"
                  className="flex-1 min-w-0 h-8 px-2.5 rounded-lg border wb-border wb-bg text-xs font-mono wb-ink"
                />
                <button
                  type="button"
                  onClick={handleCreateBranch}
                  disabled={!newBranchName.trim()}
                  className="h-8 px-2.5 rounded-lg border wb-border text-xs font-medium wb-ink inline-flex items-center gap-1 disabled:opacity-40 whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>新建分支</span>
                </button>
              </div>
            )}
          </div>

          <div className="lg:col-span-8 rounded-xl border wb-border wb-panel flex flex-col min-h-[500px]">
            <div className="p-3 border-b wb-border flex flex-wrap items-center gap-2">
              <GitBranch className="w-4 h-4 wb-accent-text shrink-0" />
              <span className="text-xs font-mono wb-muted">{selectedBranch} /</span>
              <input
                type="text"
                value={activeFilePath}
                onChange={(e) => setActiveFilePath(e.target.value)}
                placeholder="输入或点击左侧文件路径 (例如 README.md)"
                className="flex-1 min-w-[160px] h-8 px-2.5 rounded-lg border wb-border wb-bg text-xs font-mono wb-ink"
              />
              <button
                type="button"
                onClick={() => onStartRepoChat(selectedRepo, selectedBranch, activeFilePath, fileContent)}
                disabled={!activeFilePath}
                className="h-8 px-3 rounded-lg border wb-border text-xs font-medium wb-ink disabled:opacity-40 whitespace-nowrap"
              >
                带着此文件提问 AI
              </button>
            </div>

            <textarea
              value={fileContent}
              onChange={(e) => setFileContent(e.target.value)}
              placeholder="点击左侧仓库文件读取内容，或直接在此编写代码/文档后提交推送到所选分支…"
              className="flex-1 w-full p-4 wb-bg font-mono text-xs leading-relaxed wb-ink resize-none focus:outline-none"
            />

            <div className="p-3 border-t wb-border flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                placeholder="Commit 提交说明"
                className="flex-1 min-w-[180px] h-9 px-3 rounded-lg border wb-border wb-bg text-xs wb-ink"
              />
              <button
                type="button"
                onClick={handlePushFile}
                disabled={pushing || !gitUser || !activeFilePath.trim()}
                className="h-9 px-4 rounded-lg wb-accent text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-40 whitespace-nowrap"
              >
                <Save className="w-3.5 h-3.5" />
                <span>{pushing ? '提交推送中...' : '提交并推送到分支'}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

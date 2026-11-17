import React, { useEffect, useState } from 'react';
import {
  Check,
  ExternalLink,
  FileCode2,
  FolderGit2,
  GitBranch,
  Github,
  KeyRound,
  LogOut,
  MessageSquarePlus,
  Plus,
  RefreshCw,
  Save,
  UploadCloud,
} from 'lucide-react';
import { GitProviderType, GitRepo, GitTreeItem, GitUser } from '../types';

interface GitHubWorkspaceProps {
  gitProvider: GitProviderType;
  gitHostUrl: string;
  gitUser: GitUser | null;
  gitToken: string;
  oauthConfigured: boolean;
  appUrl: string;
  targetRepoUrl: string;
  selectedRepo: string;
  selectedBranch: string;
  onChangeProvider: (provider: GitProviderType, hostUrl: string) => void;
  onSaveTargetRepoUrl: (url: string) => void;
  onChangeRepoBranch: (repo: string, branch: string) => void;
  onOAuthConnect: () => void;
  onTokenConnect: (provider: GitProviderType, token: string, hostUrl: string) => Promise<void>;
  onDisconnect: (provider: GitProviderType) => Promise<void>;
  onStartRepoChat: (repo: string, branch: string, filePath?: string, fileContent?: string) => void;
  pendingCodeToPush?: { code: string; lang: string } | null;
  onClearPendingCode: () => void;
}

export const GitHubWorkspace: React.FC<GitHubWorkspaceProps> = ({
  gitProvider,
  gitHostUrl,
  gitUser,
  gitToken,
  oauthConfigured,
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

  useEffect(() => {
    if (pendingCodeToPush) {
      setFileContent(pendingCodeToPush.code);
      if (!activeFilePath) {
        const ext = pendingCodeToPush.lang || 'ts';
        setActiveFilePath(`src/generated-${Date.now()}.${ext}`);
      }
      setStatusMsg('已载入 AI 生成的代码片段，请确认文件路径后点击“提交并推送到分支”。');
      onClearPendingCode();
    }
  }, [pendingCodeToPush, activeFilePath, onClearPendingCode]);

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
        {/* Provider Switcher + Custom Saveable Target Repo */}
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
                    ? `已连接 [${gitProvider.toUpperCase()}]：${gitUser.login} · Token 连接状态已保存`
                    : `当前未连接 ${gitProvider.toUpperCase()}，支持保存 Token 连接或跳转 OAuth 授权`}
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

          {/* Customizable & Saveable Target Repo URL */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-2.5 pt-2 border-t wb-border items-end">
            <div className="md:col-span-8 flex flex-col gap-1">
              <label className="text-xs wb-muted">可管理可自定义保存的目标开源仓库地址（默认 https://github.com/757926525/bcai）</label>
              <input
                type="text"
                value={targetUrlInput}
                onChange={(e) => setTargetUrlInput(e.target.value)}
                placeholder="https://github.com/757926525/bcai"
                className="h-9 px-3 rounded-lg border wb-border wb-bg text-xs font-mono wb-ink"
              />
            </div>
            <div className="md:col-span-4 flex gap-2">
              <button
                type="button"
                onClick={handleSaveCustomTarget}
                className="flex-1 h-9 px-3 rounded-lg wb-accent text-xs font-medium whitespace-nowrap"
              >
                保存目标仓库地址
              </button>
              {gitProvider === 'github' && (
                <button
                  type="button"
                  onClick={onOAuthConnect}
                  className="h-9 px-3 rounded-lg border wb-border wb-panel text-xs font-medium wb-ink inline-flex items-center gap-1 whitespace-nowrap"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>OAuth 授权</span>
                </button>
              )}
              {gitUser && (
                <button
                  type="button"
                  onClick={() => onDisconnect(gitProvider)}
                  className="h-9 px-3 rounded-lg border wb-border text-xs text-red-600 dark:text-red-400 inline-flex items-center gap-1 whitespace-nowrap"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>断开</span>
                </button>
              )}
            </div>
          </div>

          {/* Token Form */}
          {!gitUser && (
            <form onSubmit={handlePatSubmit} className="flex flex-wrap items-center gap-2 pt-2 border-t wb-border">
              <KeyRound className="w-4 h-4 wb-muted shrink-0" />
              {gitProvider === 'gitlab' && (
                <input
                  type="text"
                  value={hostInput}
                  onChange={(e) => setHostInput(e.target.value)}
                  placeholder="https://gitlab.com 或私有 GitLab 地址"
                  className="w-56 h-9 px-3 rounded-lg border wb-border wb-bg text-xs font-mono wb-ink"
                />
              )}
              <input
                type="password"
                value={patInput}
                onChange={(e) => setPatInput(e.target.value)}
                placeholder={`输入 ${gitProvider.toUpperCase()} Access Token 并保存连接状态`}
                className="flex-1 min-w-[220px] h-9 px-3 rounded-lg border wb-border wb-bg text-xs wb-ink"
              />
              <button
                type="submit"
                disabled={connecting || !patInput.trim()}
                className="h-9 px-4 rounded-lg wb-accent text-xs font-medium disabled:opacity-50 whitespace-nowrap"
              >
                {connecting ? '连接中...' : '保存 Token 连接'}
              </button>
              {gitProvider === 'github' && !oauthConfigured && (
                <span className="text-[11px] wb-muted w-full">
                  OAuth 回调地址参考：<code className="font-mono">{appUrl}/auth/callback</code>
                </span>
              )}
            </form>
          )}

          {/* Repo & Branch Picker */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-3 pt-3 border-t wb-border items-end">
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

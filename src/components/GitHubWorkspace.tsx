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
import { GitHubRepo, GitHubTreeItem, GitHubUser } from '../types';

interface GitHubWorkspaceProps {
  githubUser: GitHubUser | null;
  githubToken: string;
  oauthConfigured: boolean;
  appUrl: string;
  selectedRepo: string;
  selectedBranch: string;
  onChangeRepoBranch: (repo: string, branch: string) => void;
  onOAuthConnect: () => void;
  onPatConnect: (token: string) => Promise<void>;
  onDisconnect: () => Promise<void>;
  onStartRepoChat: (repo: string, branch: string, filePath?: string, fileContent?: string) => void;
  pendingCodeToPush?: { code: string; lang: string } | null;
  onClearPendingCode: () => void;
}

export const GitHubWorkspace: React.FC<GitHubWorkspaceProps> = ({
  githubUser,
  githubToken,
  oauthConfigured,
  appUrl,
  selectedRepo,
  selectedBranch,
  onChangeRepoBranch,
  onOAuthConnect,
  onPatConnect,
  onDisconnect,
  onStartRepoChat,
  pendingCodeToPush,
  onClearPendingCode,
}) => {
  const [patInput, setPatInput] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [branches, setBranches] = useState<string[]>(['main']);
  const [customRepoInput, setCustomRepoInput] = useState(selectedRepo || '757926525/aimx');
  const [tree, setTree] = useState<GitHubTreeItem[]>([]);
  const [loadingTree, setLoadingTree] = useState(false);

  const [activeFilePath, setActiveFilePath] = useState('');
  const [fileContent, setFileContent] = useState('');
  const [fileSha, setFileSha] = useState('');
  const [commitMessage, setCommitMessage] = useState('Update via AIMX AI 工作台');
  const [newBranchName, setNewBranchName] = useState('');
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [pushing, setPushing] = useState(false);
  const [syncingProject, setSyncingProject] = useState(false);

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

  const ghHeaders = () => {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (githubToken) h['x-github-token'] = githubToken;
    return h;
  };

  const loadRepos = async () => {
    setErrorMsg('');
    try {
      const r = await fetch('/api/github/repos', { headers: ghHeaders() });
      const data = (await r.json()) as { repos?: GitHubRepo[]; error?: string };
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
        fetch(`/api/github/branches?repo=${encodeURIComponent(repo)}`, { headers: ghHeaders() }),
        fetch(`/api/github/tree?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}`, {
          headers: ghHeaders(),
        }),
      ]);
      const brData = (await brRes.json()) as { branches?: Array<{ name: string }> };
      if (Array.isArray(brData.branches) && brData.branches.length > 0) {
        setBranches(brData.branches.map((b) => b.name));
      }
      const trData = (await trRes.json()) as { tree?: GitHubTreeItem[]; error?: string };
      if (trRes.ok && Array.isArray(trData.tree)) {
        setTree(trData.tree.filter((i) => i.type === 'blob').slice(0, 180));
      } else {
        setTree([]);
        const msg = trData.error || '';
        if (trRes.status === 409 || msg.toLowerCase().includes('empty')) {
          setStatusMsg(`仓库 ${repo} 当前为空仓库，连接 Token 后点击「推送本项目到仓库」即可自动初始化 ${branch} 分支并上传全部源码。`);
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
    if (githubUser) {
      loadRepos();
    }
  }, [githubUser]);

  useEffect(() => {
    if (selectedRepo) {
      loadBranchesAndTree(selectedRepo, selectedBranch || 'main');
    }
  }, [selectedRepo, selectedBranch, githubUser]);

  const handleOpenFile = async (path: string) => {
    setErrorMsg('');
    setStatusMsg('');
    try {
      const r = await fetch(
        `/api/github/file?repo=${encodeURIComponent(selectedRepo)}&branch=${encodeURIComponent(selectedBranch)}&path=${encodeURIComponent(path)}`,
        { headers: ghHeaders() }
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
      const r = await fetch('/api/github/branch', {
        method: 'POST',
        headers: ghHeaders(),
        body: JSON.stringify({ repo: selectedRepo, newBranch: clean, fromBranch: selectedBranch }),
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
      const r = await fetch('/api/github/file', {
        method: 'PUT',
        headers: ghHeaders(),
        body: JSON.stringify({
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
      const headers = ghHeaders();
      const inlineToken = patInput.trim();
      if (!githubToken && inlineToken) {
        headers['x-github-token'] = inlineToken;
      }
      const r = await fetch('/api/github/sync-project', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          repo: selectedRepo || '757926525/aimx',
          branch: selectedBranch || 'main',
          commitMessage: 'feat: AIMX AI Workbench full-stack & Cloudflare Pages project',
        }),
      });
      const data = (await r.json()) as {
        pushedCount?: number;
        total?: number;
        commitSha?: string;
        commitUrl?: string;
        errors?: string[];
        error?: string;
      };
      if (!r.ok) throw new Error(data.error || '同步项目失败');
      if (!githubUser && inlineToken) {
        await onPatConnect(inlineToken);
        setPatInput('');
      }
      setStatusMsg(
        `已成功原子提交并推送 ${data.pushedCount}/${data.total} 个文件到 ${selectedRepo}@${selectedBranch}${data.commitSha ? ` (${data.commitSha.slice(0, 7)})` : ''}`
      );
      if (data.errors?.length) {
        setErrorMsg(`部分文件提示: ${data.errors.slice(0, 3).join('; ')}`);
      }
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
      await onPatConnect(patInput.trim());
      setPatInput('');
    } catch (err: any) {
      setErrorMsg(err?.message || 'Token 验证失败');
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6">
      <div className="max-w-6xl mx-auto space-y-5">
        {/* Top Auth & Repo Selection Bar */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
                <Github className="w-5 h-5 text-slate-800 dark:text-slate-200" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  GitHub 仓库授权与分支读写协同
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {githubUser
                    ? `已授权登录：${githubUser.login} · 连接状态已保存`
                    : '未连接 GitHub 账号，可跳转 OAuth 授权或使用 Personal Access Token'}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={onOAuthConnect}
                className="h-9 px-3.5 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs font-medium inline-flex items-center gap-1.5 hover:opacity-90"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span>{githubUser ? '重新 OAuth 授权' : '跳转到 GitHub 授权连接'}</span>
              </button>
              {githubUser && (
                <button
                  type="button"
                  onClick={onDisconnect}
                  className="h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-800 text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>断开连接</span>
                </button>
              )}
            </div>
          </div>

          {!githubUser && (
            <form onSubmit={handlePatSubmit} className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
              <KeyRound className="w-4 h-4 text-slate-400 shrink-0" />
              <input
                type="password"
                value={patInput}
                onChange={(e) => setPatInput(e.target.value)}
                placeholder="或输入 GitHub Personal Access Token (ghp_... 需含 repo 权限) 并保存连接状态"
                className="flex-1 min-w-[240px] h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-xs text-slate-900 dark:text-slate-100"
              />
              <button
                type="submit"
                disabled={connecting || !patInput.trim()}
                className="h-9 px-4 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                {connecting ? '连接中...' : '保存 Token 连接'}
              </button>
              {!oauthConfigured && (
                <span className="text-[11px] text-slate-500 dark:text-slate-400 w-full">
                  提示：如需启用一键跳转 OAuth，请在 GitHub Developer Settings 注册回调地址{' '}
                  <code className="font-mono">{appUrl}/auth/callback</code> 并配置 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET。
                </span>
              )}
            </form>
          )}

          {/* Repo & Branch Picker */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-3 pt-3 border-t border-slate-100 dark:border-slate-800 items-end">
            <div className="md:col-span-5 flex flex-col gap-1">
              <label className="text-xs text-slate-500 dark:text-slate-400">选择或输入仓库（owner/repo）</label>
              <div className="flex gap-2">
                {repos.length > 0 ? (
                  <select
                    value={selectedRepo}
                    onChange={(e) => {
                      const r = repos.find((x) => x.full_name === e.target.value);
                      onChangeRepoBranch(e.target.value, r?.default_branch || 'main');
                      setCustomRepoInput(e.target.value);
                    }}
                    className="flex-1 h-9 px-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-xs text-slate-900 dark:text-slate-100"
                  >
                    <option value="757926525/aimx">757926525/aimx（默认项目仓库）</option>
                    {repos
                      .filter((r) => r.full_name !== '757926525/aimx')
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
                    placeholder="757926525/aimx"
                    className="flex-1 h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-xs font-mono text-slate-900 dark:text-slate-100"
                  />
                )}
                <button
                  type="button"
                  onClick={() => onChangeRepoBranch(customRepoInput.trim() || selectedRepo, selectedBranch)}
                  className="h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-800 text-xs hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
                >
                  载入
                </button>
              </div>
            </div>

            <div className="md:col-span-3 flex flex-col gap-1">
              <label className="text-xs text-slate-500 dark:text-slate-400">当前分支</label>
              <div className="flex gap-1.5">
                <select
                  value={selectedBranch}
                  onChange={(e) => onChangeRepoBranch(selectedRepo, e.target.value)}
                  className="flex-1 h-9 px-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-xs font-mono text-slate-900 dark:text-slate-100"
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
                  className="h-9 w-9 rounded-lg border border-slate-200 dark:border-slate-800 flex items-center justify-center hover:bg-slate-50 dark:hover:bg-slate-800"
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
                className="h-9 px-3.5 rounded-lg bg-blue-600 text-white text-xs font-medium inline-flex items-center gap-1.5 hover:bg-blue-700 whitespace-nowrap"
              >
                <MessageSquarePlus className="w-3.5 h-3.5" />
                <span>进入该仓库分支对话</span>
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
              <span>{statusMsg}</span>
            </div>
          )}
          {errorMsg && (
            <div className="px-3 py-2 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-400">
              {errorMsg}
            </div>
          )}
        </div>

        {/* File Tree & Editor Split */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* File Tree + New Branch */}
          <div className="lg:col-span-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col max-h-[540px]">
            <div className="px-3.5 py-2.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-900 dark:text-slate-100 inline-flex items-center gap-1.5">
                <FolderGit2 className="w-4 h-4 text-slate-500" />
                <span>仓库文件树 ({tree.length})</span>
              </span>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
              {tree.length === 0 ? (
                <p className="text-xs text-slate-500 p-3 text-center">
                  {loadingTree ? '正在加载目录树…' : '暂无文件记录或该分支尚未初始化。'}
                </p>
              ) : (
                tree.map((item) => (
                  <button
                    key={item.path}
                    type="button"
                    onClick={() => handleOpenFile(item.path)}
                    className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-mono truncate flex items-center gap-2 ${
                      activeFilePath === item.path
                        ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 font-medium'
                        : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                    }`}
                  >
                    <FileCode2 className="w-3.5 h-3.5 shrink-0 text-slate-400" />
                    <span className="truncate">{item.path}</span>
                  </button>
                ))
              )}
            </div>
            {githubUser && (
              <div className="p-2.5 border-t border-slate-200 dark:border-slate-800 flex gap-1.5">
                <input
                  type="text"
                  value={newBranchName}
                  onChange={(e) => setNewBranchName(e.target.value)}
                  placeholder="新分支名称 (如 feat/ai)"
                  className="flex-1 h-8 px-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-xs font-mono"
                />
                <button
                  type="button"
                  onClick={handleCreateBranch}
                  disabled={!newBranchName.trim()}
                  className="h-8 px-2.5 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1 disabled:opacity-40 whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>新建分支</span>
                </button>
              </div>
            )}
          </div>

          {/* Code Read/Write & Commit Push */}
          <div className="lg:col-span-8 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col min-h-[540px]">
            <div className="p-3 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center gap-2">
              <GitBranch className="w-4 h-4 text-blue-600 shrink-0" />
              <span className="text-xs font-mono text-slate-500">{selectedBranch} /</span>
              <input
                type="text"
                value={activeFilePath}
                onChange={(e) => setActiveFilePath(e.target.value)}
                placeholder="输入或点击左侧文件路径 (例如 README.md)"
                className="flex-1 min-w-[180px] h-8 px-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-xs font-mono text-slate-900 dark:text-slate-100"
              />
              <button
                type="button"
                onClick={() => onStartRepoChat(selectedRepo, selectedBranch, activeFilePath, fileContent)}
                disabled={!activeFilePath}
                className="h-8 px-3 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap"
              >
                带着此文件提问 AI
              </button>
            </div>

            <textarea
              value={fileContent}
              onChange={(e) => setFileContent(e.target.value)}
              placeholder="点击左侧仓库文件读取内容，或直接在此编写代码/文档后提交推送到所选分支…"
              className="flex-1 w-full p-4 bg-slate-50 dark:bg-slate-950 font-mono text-xs leading-relaxed text-slate-800 dark:text-slate-200 resize-none focus:outline-none"
            />

            <div className="p-3 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                placeholder="Commit 提交说明"
                className="flex-1 min-w-[200px] h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-xs"
              />
              <button
                type="button"
                onClick={handlePushFile}
                disabled={pushing || !githubUser || !activeFilePath.trim()}
                className="h-9 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-40 whitespace-nowrap"
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

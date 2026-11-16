import React, { useState } from 'react';
import { Check, Github, Lock, ShieldCheck, X } from 'lucide-react';
import { GitHubUser, PublicConfig } from '../types';

interface AuthPlanModalProps {
  open: boolean;
  onClose: () => void;
  publicConfig: PublicConfig | null;
  selectedPlan: 'free' | 'cloudflare' | 'pro-api';
  onSelectPlan: (plan: 'free' | 'cloudflare' | 'pro-api') => void;
  accessPassword: string;
  onSavePassword: (pw: string) => void;
  unlocked: boolean;
  onUnlocked: () => void;
  githubUser: GitHubUser | null;
  onGitHubOAuth: () => void;
}

const PLANS = [
  {
    id: 'free' as const,
    name: '免费标准工作台',
    audience: '个人学习与日常编程 / 绘图',
    price: '¥0 / 永久免费',
    limits: [
      'Cloudflare Workers AI 每日 10,000 Neurons 免费额度',
      'Gemini 免费层 1M 上下文 + Groq / DeepSeek / OpenRouter 免费端点',
      '本地会话历史与浏览器持久化，不限制新建会话数',
    ],
  },
  {
    id: 'cloudflare' as const,
    name: 'Cloudflare 全栈云原生计划',
    audience: '绑定 D1 数据库与 Pages 边缘托管',
    price: '¥0 / Cloudflare Free Tier',
    limits: [
      'Cloudflare D1 免费 5 GB 存储 / 每日 500 万行读取',
      'Pages Functions 原生 env.AI 绑定，免暴露 API Key',
      '图片资产与代码文件永久落盘，记录精确保存时间',
    ],
  },
  {
    id: 'pro-api' as const,
    name: '外接端点与仓库协同计划',
    audience: '多 API 并发与 GitHub 分支工程',
    price: '按自备 API 额度计费',
    limits: [
      '客户端直连 HTTPS SSE 流式交互，支持自定义模型列表',
      'GitHub OAuth 授权读写仓库内容、新建与推送分支',
      '支持 Docker / Vercel / VPS 独立私有化部署',
    ],
  },
];

export const AuthPlanModal: React.FC<AuthPlanModalProps> = ({
  open,
  onClose,
  publicConfig,
  selectedPlan,
  onSelectPlan,
  accessPassword,
  onSavePassword,
  unlocked,
  onUnlocked,
  githubUser,
  onGitHubOAuth,
}) => {
  const [pwInput, setPwInput] = useState(accessPassword);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  if (!open) return null;

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: pwInput, plan: selectedPlan }),
      });
      const data = (await res.json()) as { error?: string; ok?: boolean };
      if (!res.ok) {
        throw new Error(data.error || '登录验证失败');
      }
      onSavePassword(pwInput);
      onUnlocked();
      onClose();
    } catch (error: any) {
      setErr(error?.message || '验证失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
      <div className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              工作台计划与登录面板
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              选择使用方案、验证站点访问密码或绑定 GitHub 开发者账号
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-9 h-9 rounded-lg flex items-center justify-center text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="关闭登录面板"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Plans Grid */}
          <div>
            <div className="text-sm font-medium text-slate-900 dark:text-slate-100 mb-3">
              选择工作台计划方案
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {PLANS.map((p) => {
                const active = selectedPlan === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => onSelectPlan(p.id)}
                    className={`text-left p-4 rounded-xl border transition-colors flex flex-col justify-between gap-3 ${
                      active
                        ? 'border-blue-600 bg-blue-50/60 dark:bg-blue-950/30'
                        : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                          {p.name}
                        </span>
                        {active && <Check className="w-4 h-4 text-blue-600 shrink-0" />}
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{p.audience}</p>
                      <div className="text-sm font-semibold text-blue-700 dark:text-blue-400 mt-2 tabular-nums">
                        {p.price}
                      </div>
                    </div>
                    <ul className="space-y-1.5 text-xs text-slate-600 dark:text-slate-300 border-t border-slate-200/80 dark:border-slate-800 pt-2.5">
                      {p.limits.map((lim, i) => (
                        <li key={i} className="leading-snug">
                          • {lim}
                        </li>
                      ))}
                    </ul>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Login & GitHub Auth */}
          <form onSubmit={handleLogin} className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-slate-200 dark:border-slate-800">
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-slate-900 dark:text-slate-100">
                <Lock className="w-4 h-4 text-slate-500" />
                <span>站点访问验证</span>
                <span className="text-xs text-slate-500 font-normal">
                  {publicConfig?.requiresPassword
                    ? unlocked
                      ? '· 已解锁'
                      : '· 需要密码'
                    : '· 当前开放免密访问'}
                </span>
              </div>
              <input
                type="password"
                value={pwInput}
                onChange={(e) => setPwInput(e.target.value)}
                placeholder={
                  publicConfig?.requiresPassword
                    ? '请输入站点 ACCESS_PASSWORD'
                    : '可选：若后端设置了 ACCESS_PASSWORD 请在此填入'
                }
                className="w-full h-10 px-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:border-blue-600"
              />
              {err && <p className="text-xs text-red-600 dark:text-red-400">{err}</p>}
            </div>

            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-slate-900 dark:text-slate-100">
                <Github className="w-4 h-4 text-slate-500" />
                <span>GitHub 仓库账号登录</span>
              </div>
              {githubUser ? (
                <div className="h-10 px-3 rounded-lg border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50/50 dark:bg-emerald-950/20 flex items-center justify-between text-sm">
                  <span className="text-emerald-800 dark:text-emerald-300 font-medium truncate">
                    已连接账号：{githubUser.login}
                  </span>
                  <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={onGitHubOAuth}
                  className="w-full h-10 px-4 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 text-sm font-medium text-slate-800 dark:text-slate-200 inline-flex items-center justify-center gap-2 transition-colors"
                >
                  <Github className="w-4 h-4" />
                  <span>跳转 GitHub 授权登录</span>
                </button>
              )}
              <p className="text-xs text-slate-500 dark:text-slate-400">
                授权后可直接在工作台拉取仓库、切换分支对话并提交推送代码。
              </p>
            </div>

            <div className="md:col-span-2 flex items-center justify-end gap-3 pt-3 border-t border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={onClose}
                className="h-10 px-4 rounded-lg border border-slate-200 dark:border-slate-800 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={loading}
                className="h-10 px-5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                {loading ? '正在验证...' : '确认计划并进入工作台'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

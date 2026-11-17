import React, { useEffect, useState } from 'react';
import { Check, KeyRound, Lock, LogOut, ShieldCheck, X } from 'lucide-react';
import { PublicConfig } from '../types';

interface AuthPlanModalProps {
  open: boolean;
  onClose: () => void;
  publicConfig: PublicConfig | null;
  selectedPlan: 'free' | 'cloudflare' | 'pro-api';
  onSelectPlan: (plan: 'free' | 'cloudflare' | 'pro-api') => void;
  isAdmin: boolean;
  onAdminLoggedIn: (token: string, hasPw: boolean) => void;
  onAdminLoggedOut: () => void;
  onPasswordUpdated: (msg: string) => void;
}

const PLANS = [
  {
    id: 'free' as const,
    name: '免费标准工作台',
    audience: '默认开放 · 免登录直接编程与绘图',
    price: '¥0 / 永久免费',
    limits: [
      'Cloudflare Workers AI 每日 10,000 Neurons 免费额度',
      'Gemini 免费层 1M 上下文 + Groq / DeepSeek / OpenRouter / Cerebras 免费端点',
      '支持图片与代码文件上传多模态对话、绘图负向提示词与多款护眼主题',
    ],
  },
  {
    id: 'cloudflare' as const,
    name: 'Cloudflare 全栈云原生',
    audience: '管理员绑定 D1 数据库与 R2 存储桶',
    price: '¥0 / Cloudflare Free Tier',
    limits: [
      'D1 免费 5 GB 数据库 + R2 免费 10 GB 对象存储桶',
      '支持对话历史云端同步与实时状态灯监测',
      '图片资产与代码文件记录精确保存时间与存储位置',
    ],
  },
  {
    id: 'pro-api' as const,
    name: '仓库协同与连接器扩展',
    audience: '管理员接入 Git / 网盘 / 邮箱 / 部署平台',
    price: '按自备凭证扩展',
    limits: [
      '支持 GitHub / GitLab / Gitee 分支读写与整库同步推送',
      '连接器支持 Alist/WebDAV 网盘、Resend 邮箱、Cloudflare/Vercel 部署探活',
      '支持客户端直连 HTTPS SSE 流式交互与自定义模型列表',
    ],
  },
];

export const AuthPlanModal: React.FC<AuthPlanModalProps> = ({
  open,
  onClose,
  publicConfig,
  selectedPlan,
  onSelectPlan,
  isAdmin,
  onAdminLoggedIn,
  onAdminLoggedOut,
  onPasswordUpdated,
}) => {
  const [pwInput, setPwInput] = useState('');
  const [newAdminPw, setNewAdminPw] = useState('');
  const [loading, setLoading] = useState(false);
  const [savingPw, setSavingPw] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (open) {
      setErr('');
      setMsg('');
    }
  }, [open]);

  if (!open) return null;

  const handleAdminLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setMsg('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/admin-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: pwInput }),
      });
      const data = (await res.json()) as {
        error?: string;
        ok?: boolean;
        adminToken?: string;
        hasAdminPassword?: boolean;
      };
      if (!res.ok) {
        throw new Error(data.error || '管理员验证失败');
      }
      setPwInput('');
      onAdminLoggedIn(data.adminToken || '', Boolean(data.hasAdminPassword));
      onClose();
    } catch (error: any) {
      setErr(error?.message || '验证失败');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateAdminPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAdminPw.trim()) return;
    setSavingPw(true);
    setErr('');
    setMsg('');
    try {
      const res = await fetch('/api/auth/admin-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ newPassword: newAdminPw.trim() }),
      });
      const data = (await res.json()) as { error?: string; message?: string };
      if (!res.ok) throw new Error(data.error || '修改密码失败');
      setNewAdminPw('');
      setMsg(data.message || '管理员密码已更新');
      onPasswordUpdated(data.message || '管理员密码已更新');
    } catch (error: any) {
      setErr(error?.message || '修改密码失败');
    } finally {
      setSavingPw(false);
    }
  };

  const handleLogout = async () => {
    await fetch('/api/auth/admin-logout', { method: 'POST' });
    onAdminLoggedOut();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-3 sm:p-4">
      <div className="w-full max-w-3xl max-h-[92vh] flex flex-col rounded-xl border wb-border wb-panel shadow-xl overflow-hidden">
        <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b wb-border">
          <div className="min-w-0">
            <h2 className="text-base sm:text-lg font-semibold wb-ink">
              管理员登录与工作台权限管理
            </h2>
            <p className="text-xs wb-muted mt-0.5">
              普通使用默认免登录；管理员登录后解锁外接 API、数据库与存储桶、历史同步、仓库协同与连接器管理
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-10 h-10 rounded-lg flex items-center justify-center wb-muted hover:bg-black/5 dark:hover:bg-white/5 shrink-0"
            aria-label="关闭管理员面板"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">
          {/* Admin Auth Section */}
          {!isAdmin ? (
            <form onSubmit={handleAdminLogin} className="rounded-xl border wb-border p-4 space-y-3 wb-bg">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-semibold wb-ink">
                  <Lock className="w-4 h-4 wb-accent-text" />
                  <span>管理员登录</span>
                </div>
                <span className="text-xs wb-muted">
                  {publicConfig?.hasAdminPassword
                    ? publicConfig?.usingEnvPassword
                      ? '支持后台变量 ACCESS_PASSWORD 或管理员自设密码'
                      : '已设置管理员自定义密码'
                    : '尚未设定密码（可直接登录，或在下方输入初始密码直接设定并登录）'}
                </span>
              </div>

              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="password"
                  value={pwInput}
                  onChange={(e) => setPwInput(e.target.value)}
                  placeholder={
                    publicConfig?.hasAdminPassword
                      ? '请输入管理员密码或后台变量 ACCESS_PASSWORD'
                      : '留空直接进入管理区，或输入 >=4 位字符设为新管理员密码'
                  }
                  className="flex-1 h-11 px-3 rounded-lg border wb-border wb-panel text-sm wb-ink focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={loading}
                  className="h-11 px-5 rounded-lg wb-accent text-sm font-medium disabled:opacity-50 whitespace-nowrap"
                >
                  {loading ? '正在验证...' : '登录管理控制台'}
                </button>
              </div>
              {err && <p className="text-xs text-red-600 dark:text-red-400">{err}</p>}
            </form>
          ) : (
            <div className="rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-950/20 p-4 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-emerald-800 dark:text-emerald-300">
                  <ShieldCheck className="w-4 h-4" />
                  <span>已作为管理员登录（全部管理功能区已解锁可见）</span>
                </div>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="h-9 px-3 rounded-lg border border-emerald-300 dark:border-emerald-800 text-xs font-medium text-emerald-900 dark:text-emerald-200 hover:bg-emerald-100/60 dark:hover:bg-emerald-900/40 inline-flex items-center gap-1.5"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>退出管理员登录</span>
                </button>
              </div>

              <form onSubmit={handleUpdateAdminPassword} className="pt-3 border-t border-emerald-200/70 dark:border-emerald-900/60 space-y-2">
                <div className="flex items-center gap-1.5 text-xs font-medium wb-ink">
                  <KeyRound className="w-3.5 h-3.5 wb-muted" />
                  <span>设定或修改管理员登录密码（后台变量 ACCESS_PASSWORD 仍可随时直接登录）</span>
                </div>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="password"
                    value={newAdminPw}
                    onChange={(e) => setNewAdminPw(e.target.value)}
                    placeholder="输入新管理员密码（至少 4 位字符）"
                    className="flex-1 h-10 px-3 rounded-lg border wb-border wb-panel text-xs wb-ink focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={savingPw || newAdminPw.trim().length < 4}
                    className="h-10 px-4 rounded-lg wb-accent text-xs font-medium disabled:opacity-50 whitespace-nowrap"
                  >
                    {savingPw ? '保存中...' : '保存新密码'}
                  </button>
                </div>
                {msg && <p className="text-xs text-emerald-700 dark:text-emerald-400">{msg}</p>}
                {err && <p className="text-xs text-red-600 dark:text-red-400">{err}</p>}
              </form>
            </div>
          )}

          {/* Plans Overview */}
          <div>
            <div className="text-sm font-medium wb-ink mb-3">
              工作台运行模式参考
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
                      active ? 'border-blue-600 wb-tint' : 'wb-border hover:opacity-90'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold wb-ink">{p.name}</span>
                        {active && <Check className="w-4 h-4 wb-accent-text shrink-0" />}
                      </div>
                      <p className="text-xs wb-muted mt-1">{p.audience}</p>
                      <div className="text-sm font-semibold wb-accent-text mt-2 tabular-nums">
                        {p.price}
                      </div>
                    </div>
                    <ul className="space-y-1.5 text-xs wb-muted border-t wb-border pt-2.5">
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
        </div>
      </div>
    </div>
  );
};

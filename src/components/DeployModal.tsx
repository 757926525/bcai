import React, { useState } from 'react';
import { Check, Copy, Download, ExternalLink, Github, Rocket, X } from 'lucide-react';

interface DeployModalProps {
  open: boolean;
  onClose: () => void;
  onOpenGitHubTab: () => void;
}

type PlatformKey = 'pages-upload' | 'pages-git' | 'vercel' | 'docker' | 'vps';

const PLATFORM_GUIDES: Record<
  PlatformKey,
  {
    title: string;
    summary: string;
    commands: string;
    notes: string[];
  }
> = {
  'pages-upload': {
    title: 'Cloudflare Pages 上传部署（Direct Upload）',
    summary: '无需本地配置构建环境，直接下载预打包的 Pages 上传包，解压后即可上传到 Cloudflare Pages 或通过 Wrangler CLI 一键发布。',
    commands: `# 1. 解压下载的 aimx-cloudflare-pages-deploy.zip 后在目录中执行:
npx wrangler pages deploy . --project-name=aimx

# 2. 创建并初始化 Cloudflare D1 数据库:
npx wrangler d1 create aimx-db
npx wrangler d1 execute aimx-db --remote --file=./schema.sql`,
    notes: [
      '上传包内置 dist/ 前端产物、functions/ 边缘接口、_routes.json、wrangler.toml 与 schema.sql。',
      '部署后进入 Cloudflare Dashboard -> Pages -> Settings -> Functions 绑定 AI (Workers AI) 与 DB (D1)。',
      '绑定的 AI 变量名必须为 AI，D1 变量名必须为 DB。',
    ],
  },
  'pages-git': {
    title: 'Cloudflare Pages 拉取部署（Git Pull 自动构建）',
    summary: '将项目推送到 GitHub 仓库 https://github.com/757926525/aimx 后，在 Cloudflare Pages 连接仓库即可每次 Push 自动构建部署。',
    commands: `# 构建配置参数:
Framework preset: Vite
Build command: npm run build
Build output directory: dist

# D1 远程建表（首次部署执行一次）:
npx wrangler d1 execute aimx-db --remote --file=./schema.sql`,
    notes: [
      'Pages Settings -> Environment variables 可配置 GEMINI_API_KEY、ACCESS_PASSWORD、GITHUB_CLIENT_ID 等变量。',
      '同时在 Functions 面板绑定 Workers AI (AI) 后，选区一所有模型无需额外 Token 即可免费使用。',
    ],
  },
  vercel: {
    title: 'Vercel 拉取 / CLI 部署',
    summary: '仓库根目录已包含 vercel.json，导入 GitHub 仓库即可完成零配置前端构建与环境变量注入。',
    commands: `# 使用 Vercel CLI 部署:
npm i -g vercel
vercel --prod

# 或访问 Vercel 控制台直接 Import Git Repository:
# https://github.com/757926525/aimx`,
    notes: [
      '在 Vercel Project Settings -> Environment Variables 添加 GEMINI_API_KEY、CF_ACCOUNT_ID、CF_API_TOKEN 等。',
      '若需在 Vercel 上绑定 Cloudflare D1，请额外填入 CF_D1_DATABASE_ID。',
    ],
  },
  docker: {
    title: 'Docker / Docker Compose 部署',
    summary: '仓库自带多阶段构建 Dockerfile 与 docker-compose.yml，自动挂载 .data 持久化卷。',
    commands: `git clone https://github.com/757926525/aimx.git
cd aimx
cp .env.example .env
# 编辑 .env 填写所需 API Key 或 Cloudflare D1 凭证
docker compose up -d --build`,
    notes: [
      '服务默认监听 3000 端口，可通过 Nginx/Caddy 反代并配置 HTTPS。',
      '未绑定 Cloudflare D1 时，上传的图片与文件会自动保存在 aimx_data Docker 卷中。',
    ],
  },
  vps: {
    title: 'Linux 服务器 / VPS 部署（Node.js + PM2 + Nginx）',
    summary: '适用于 Ubuntu / Debian / CentOS 等独立云主机，支持前后端一体化 Express 服务与 SSE 零延迟流式输出。',
    commands: `git clone https://github.com/757926525/aimx.git
cd aimx
npm ci
cp .env.example .env
npm run build
npx pm2 start "npx tsx server.ts" --name aimx
npx pm2 save`,
    notes: [
      'Nginx 反向代理请务必添加 proxy_buffering off; 与 proxy_cache off; 以保障 AI 打字机流式传输实时返回。',
      '如启用 GitHub OAuth 授权登录，请将 .env 中的 APP_URL 设为你的完整域名（如 https://ai.example.com）。',
    ],
  },
};

export const DeployModal: React.FC<DeployModalProps> = ({ open, onClose, onOpenGitHubTab }) => {
  const [platform, setPlatform] = useState<PlatformKey>('pages-upload');
  const [copied, setCopied] = useState(false);

  if (!open) return null;

  const active = PLATFORM_GUIDES[platform];

  const copyCommands = () => {
    navigator.clipboard?.writeText(active.commands).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
      <div className="w-full max-w-4xl max-h-[90vh] flex flex-col rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-2.5">
            <Rocket className="w-5 h-5 text-blue-600" />
            <div>
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                多平台部署中心与 Cloudflare Pages 上传包下载
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                目标开源仓库：<span className="font-mono">https://github.com/757926525/aimx</span>
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-9 h-9 rounded-lg flex items-center justify-center text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Direct Download Banner */}
          <div className="rounded-xl border border-blue-200 dark:border-blue-900 bg-blue-50/60 dark:bg-blue-950/30 p-4 flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Cloudflare Pages 上传部署包（含前端构建产物 + Functions + D1 Schema）
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-300">
                下载地址：<code className="font-mono">/api/deploy/pages-package.zip</code>，直接包含 <code className="font-mono">functions/</code>、<code className="font-mono">_routes.json</code>、<code className="font-mono">wrangler.toml</code> 与 <code className="font-mono">schema.sql</code>。
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <a
                href="/api/deploy/pages-package.zip"
                download="aimx-cloudflare-pages-deploy.zip"
                className="h-10 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                <Download className="w-4 h-4" />
                <span>下载 Pages 部署包 (.zip)</span>
              </a>
              <a
                href="/api/deploy/source-package.zip"
                download="aimx-full-source.zip"
                className="h-10 px-4 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                <Download className="w-4 h-4" />
                <span>下载完整源码包 (.zip)</span>
              </a>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenGitHubTab();
                }}
                className="h-10 px-4 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                <Github className="w-4 h-4" />
                <span>同步推送到 757926525/aimx</span>
              </button>
            </div>
          </div>

          {/* Platform Switcher */}
          <div className="flex flex-wrap gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800">
            {(
              [
                ['pages-upload', 'Pages 上传部署'],
                ['pages-git', 'Pages 拉取部署'],
                ['vercel', 'Vercel 部署'],
                ['docker', 'Docker 部署'],
                ['vps', '服务器 / VPS'],
              ] as Array<[PlatformKey, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setPlatform(key)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                  platform === key
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Active Guide */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-4 space-y-3">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{active.title}</h3>
            <p className="text-xs text-slate-600 dark:text-slate-300">{active.summary}</p>

            <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 overflow-hidden">
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-200 dark:border-slate-800 text-xs text-slate-500">
                <span>部署命令与配置</span>
                <button
                  type="button"
                  onClick={copyCommands}
                  className="inline-flex items-center gap-1 text-slate-700 dark:text-slate-300 hover:text-blue-600"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copied ? '已复制' : '复制命令'}</span>
                </button>
              </div>
              <pre className="p-3 text-xs font-mono text-slate-800 dark:text-slate-200 overflow-x-auto leading-relaxed">
                <code>{active.commands}</code>
              </pre>
            </div>

            <ul className="space-y-1 text-xs text-slate-600 dark:text-slate-400">
              {active.notes.map((n, i) => (
                <li key={i}>• {n}</li>
              ))}
            </ul>
          </div>

          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 pt-1">
            <span>完整环境变量说明与架构文档已写入仓库根目录 README.md。</span>
            <a
              href="https://github.com/757926525/aimx"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline"
            >
              <span>打开仓库 757926525/aimx</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};

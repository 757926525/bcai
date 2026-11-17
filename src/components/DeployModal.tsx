import React, { useState } from 'react';
import { BookOpen, Check, Copy, Database, Download, ExternalLink, FolderGit2, HardDrive, Rocket, X } from 'lucide-react';

interface DeployModalProps {
  open: boolean;
  onClose: () => void;
  targetRepoUrl: string;
  onSaveTargetRepoUrl: (url: string) => void;
  onOpenGitHubTab: () => void;
}

type GuideTabKey =
  | 'usage-repo'
  | 'usage-db-bucket'
  | 'pages-upload'
  | 'pages-git'
  | 'vercel'
  | 'docker'
  | 'vps';

export const DeployModal: React.FC<DeployModalProps> = ({
  open,
  onClose,
  targetRepoUrl,
  onSaveTargetRepoUrl,
  onOpenGitHubTab,
}) => {
  const [platform, setPlatform] = useState<GuideTabKey>('usage-repo');
  const [copied, setCopied] = useState(false);
  const [repoInput, setRepoInput] = useState(targetRepoUrl || 'https://github.com/757926525/bcai');

  if (!open) return null;

  const cleanRepoUrl = (targetRepoUrl || 'https://github.com/757926525/bcai').replace(/\/+$/, '');
  const repoSlug = (() => {
    try {
      return new URL(cleanRepoUrl).pathname.replace(/^\/+|\/+$/g, '') || '757926525/bcai';
    } catch {
      return '757926525/bcai';
    }
  })();

  const GUIDES: Record<
    GuideTabKey,
    {
      title: string;
      summary: string;
      commands: string;
      notes: string[];
    }
  > = {
    'usage-repo': {
      title: '仓库连接与多平台代码协同使用说明',
      summary: '管理员登录后即可在左侧「仓库连接」进入协同中心，支持 GitHub、GitLab（含私有自建实例）与 Gitee 码云，且支持自定义保存目标开源仓库地址。',
      commands: `# 1. 目标开源仓库默认地址（可在页面随时修改并持久化保存）:
${cleanRepoUrl}

# 2. 仓库分支对话与提交推送流程:
- 在「仓库连接」选择 GitHub / GitLab / Gitee 并保存 Access Token（或跳转 GitHub OAuth）
- 载入仓库与分支后，点击目录树文件即可在线读取、编辑并直接 Commit & Push 到所选分支
- 点击「进入仓库分支对话」，对话框顶部会实时显示当前仓库与分支，AI 回复代码可一键发送推送`,
      notes: [
        '普通访客默认免登录进入工作台编程/绘图；仓库连接、数据库与外接 API 管理仅管理员登录后可见。',
        '点击「推送本项目到仓库」可一键将当前 BCAI 全栈源码原子提交到目标仓库（自动初始化空仓库）。',
      ],
    },
    'usage-db-bucket': {
      title: '数据库 (D1) 与对象存储桶 (R2/S3) 及同步状态说明',
      summary: '支持 Cloudflare D1 数据库（原生 env.DB 绑定或独立运行 D1 HTTP API）与 Cloudflare R2 / S3 兼容存储桶，并在每条文件记录明确标注存储位置。',
      commands: `# 1. 独立部署绑定 D1 HTTP API 所需三要素:
CF_ACCOUNT_ID="32位 Cloudflare Account ID"
CF_D1_DATABASE_ID="D1 数据库 UUID"
CF_API_TOKEN="具备 D1:Edit 与 Workers AI:Edit 权限的 Token"

# 2. 绑定 Cloudflare R2 / S3 兼容存储桶所需参数:
S3_ENDPOINT="https://<ACCOUNT_ID>.r2.cloudflarestorage.com"
S3_REGION="auto"
S3_BUCKET="bcai-storage"
S3_ACCESS_KEY_ID="R2 Access Key ID"
S3_SECRET_ACCESS_KEY="R2 Secret Access Key"`,
      notes: [
        '工作台顶部与数据库抽屉均设有三个真实状态灯：数据库连接灯、存储桶连接灯、历史同步成功灯（绝不虚报绿灯）。',
        '对话历史可一键同步到已绑定的 D1 与存储桶，也可在聊天抽屉勾选多个会话合并导出为自定义命名的 .txt 文件。',
        '文件列表清楚区分「Cloudflare D1」「存储桶 (R2/S3)」「本地存储」，支持任意上传、下载与删除。',
      ],
    },
    'pages-upload': {
      title: 'Cloudflare Pages 上传部署（Direct Upload）',
      summary: '直接下载预打包的 Pages 上传部署包（内置编译后前端 dist/ 与根目录 _worker.js 全栈服务端），上传即可运行无需本地构建。',
      commands: `# 1. 解压 bcai-cloudflare-pages-deploy.zip 后可用 Wrangler 发布:
npx wrangler pages deploy . --project-name=bcai

# 2. 创建并初始化 Cloudflare D1 数据库:
npx wrangler d1 create bcai-db
npx wrangler d1 execute bcai-db --remote --file=./schema.sql`,
      notes: [
        'Dashboard 网页上传时请直接上传包含 dist 内容与 _worker.js 的目录或 zip。',
        '在 Pages -> Settings -> Functions 绑定：AI (Workers AI)、DB (D1)、BUCKET (R2，可选)。',
        '如需设置后台变量登录密码，在 Environment Variables 添加 ACCESS_PASSWORD。',
      ],
    },
    'pages-git': {
      title: 'Cloudflare Pages 拉取部署（Git Pull 自动构建）',
      summary: `将项目推送到 ${cleanRepoUrl} 后，在 Cloudflare Pages 连接仓库即可每次 Push 自动构建部署。`,
      commands: `# 构建配置参数:
Framework preset: Vite
Build command: npm run build
Build output directory: dist

# D1 远程建表（首次部署执行一次）:
npx wrangler d1 execute bcai-db --remote --file=./schema.sql`,
      notes: [
        'Pages Settings -> Environment variables 可配置 GEMINI_API_KEY、ACCESS_PASSWORD、TARGET_REPO_URL 等变量。',
        '绑定 Workers AI (AI) 后，所有内置 Workers AI 文本与绘图模型无需 Token 即可免费使用。',
      ],
    },
    vercel: {
      title: 'Vercel 拉取 / CLI 部署',
      summary: '仓库根目录已包含 vercel.json 与 /api Serverless 适配，导入仓库即可部署。',
      commands: `npm i -g vercel
vercel --prod

# 或访问 Vercel 控制台导入仓库:
# ${cleanRepoUrl}`,
      notes: [
        '在 Vercel Environment Variables 添加 GEMINI_API_KEY、ACCESS_PASSWORD、CF_ACCOUNT_ID、CF_API_TOKEN、CF_D1_DATABASE_ID。',
        '如需使用存储桶同步，添加 S3_ENDPOINT、S3_BUCKET、S3_ACCESS_KEY_ID、S3_SECRET_ACCESS_KEY。',
      ],
    },
    docker: {
      title: 'Docker / Docker Compose 部署',
      summary: '自带多阶段构建 Dockerfile 与 docker-compose.yml，自动持久化 .data 目录。',
      commands: `git clone ${cleanRepoUrl}.git
cd ${repoSlug.split('/').pop() || 'bcai'}
cp .env.example .env
docker compose up -d --build`,
      notes: [
        '服务监听 3000 端口，未绑定远程 D1 时数据安全保存在本地挂载卷中。',
        '管理员自定义密码、外接连接器与绑定配置会自动持久化。',
      ],
    },
    vps: {
      title: 'Linux 服务器 / VPS 部署（Node.js 22+ / PM2 / Nginx）',
      summary: '适用于独立云主机，完整支持 Node.js 22 原生运行 server.ts 与 SSE 零延迟流式传输。',
      commands: `git clone ${cleanRepoUrl}.git
cd ${repoSlug.split('/').pop() || 'bcai'}
npm ci
cp .env.example .env
npm run build
npx pm2 start "NODE_ENV=production node server.ts" --name bcai`,
      notes: [
        'Nginx 反代请配置 proxy_buffering off; 与 proxy_cache off; 以保证流式输出实时到达。',
        '通过 .env 设置 ACCESS_PASSWORD 后，管理员可直接使用该密码登录，也可在面板内修改自定义密码。',
      ],
    },
  };

  const active = GUIDES[platform];

  const copyCommands = () => {
    navigator.clipboard?.writeText(active.commands).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-2 sm:p-4">
      <div className="w-full max-w-4xl max-h-[92vh] flex flex-col rounded-xl border wb-border wb-panel shadow-xl overflow-hidden">
        <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b wb-border gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <Rocket className="w-5 h-5 wb-accent-text shrink-0" />
            <div className="min-w-0">
              <h2 className="text-base sm:text-lg font-semibold wb-ink">部署和使用</h2>
              <p className="text-xs wb-muted truncate">
                目标开源仓库：<span className="font-mono">{cleanRepoUrl}</span>
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-10 h-10 rounded-lg flex items-center justify-center wb-muted hover:bg-black/5 dark:hover:bg-white/5 shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-5">
          {/* Custom Saveable Target Repo Bar */}
          <div className="rounded-xl border wb-border wb-bg p-3.5 flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium wb-ink whitespace-nowrap">目标仓库地址：</span>
            <input
              type="text"
              value={repoInput}
              onChange={(e) => setRepoInput(e.target.value)}
              placeholder="https://github.com/757926525/bcai"
              className="flex-1 min-w-[200px] h-9 px-3 rounded-lg border wb-border wb-panel text-xs font-mono wb-ink"
            />
            <button
              type="button"
              onClick={() => onSaveTargetRepoUrl(repoInput.trim() || 'https://github.com/757926525/bcai')}
              className="h-9 px-3.5 rounded-lg wb-accent text-xs font-medium whitespace-nowrap"
            >
              保存仓库地址
            </button>
          </div>

          {/* Direct Download Banner */}
          <div className="rounded-xl border wb-border wb-tint p-4 flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1 min-w-0">
              <div className="text-sm font-semibold wb-ink">
                Cloudflare Pages 上传部署包 & 完整源码包下载
              </div>
              <p className="text-xs wb-muted">
                上传包内含 <code className="font-mono">dist/</code>、<code className="font-mono">_worker.js</code>、<code className="font-mono">wrangler.toml</code> 与 <code className="font-mono">schema.sql</code>。
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <a
                href="/api/deploy/pages-package.zip"
                download="bcai-cloudflare-pages-deploy.zip"
                className="h-10 px-4 rounded-lg wb-accent text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                <Download className="w-4 h-4" />
                <span>下载 Pages 上传包 (.zip)</span>
              </a>
              <a
                href="/api/deploy/source-package.zip"
                download="bcai-full-source.zip"
                className="h-10 px-4 rounded-lg border wb-border wb-panel text-xs font-medium wb-ink inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                <Download className="w-4 h-4" />
                <span>下载源码包 (.zip)</span>
              </a>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenGitHubTab();
                }}
                className="h-10 px-4 rounded-lg border wb-border wb-panel text-xs font-medium wb-ink inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                <FolderGit2 className="w-4 h-4" />
                <span>推送至 {repoSlug}</span>
              </button>
            </div>
          </div>

          {/* Switcher */}
          <div className="flex flex-wrap gap-1 p-1 rounded-lg wb-bg border wb-border">
            {(
              [
                ['usage-repo', '仓库连接使用', FolderGit2],
                ['usage-db-bucket', 'D1 与存储桶使用', Database],
                ['pages-upload', 'Pages 上传部署', HardDrive],
                ['pages-git', 'Pages 拉取部署', BookOpen],
                ['vercel', 'Vercel 部署', Rocket],
                ['docker', 'Docker 部署', Rocket],
                ['vps', '服务器 / VPS', Rocket],
              ] as Array<[GuideTabKey, string, React.ComponentType<{ className?: string }>]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setPlatform(key)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                  platform === key ? 'wb-panel wb-ink shadow-sm' : 'wb-muted'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Active Guide */}
          <div className="rounded-xl border wb-border p-4 space-y-3">
            <h3 className="text-sm font-semibold wb-ink">{active.title}</h3>
            <p className="text-xs wb-muted">{active.summary}</p>

            <div className="rounded-lg border wb-border wb-bg overflow-hidden">
              <div className="flex items-center justify-between px-3 py-1.5 border-b wb-border text-xs wb-muted">
                <span>配置说明与参考命令</span>
                <button
                  type="button"
                  onClick={copyCommands}
                  className="inline-flex items-center gap-1 wb-ink hover:wb-accent-text"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copied ? '已复制' : '复制内容'}</span>
                </button>
              </div>
              <pre className="p-3 text-xs font-mono wb-ink overflow-x-auto leading-relaxed">
                <code>{active.commands}</code>
              </pre>
            </div>

            <ul className="space-y-1 text-xs wb-muted">
              {active.notes.map((n, i) => (
                <li key={i}>• {n}</li>
              ))}
            </ul>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs wb-muted pt-1">
            <span>完整环境变量与架构文档已写入仓库根目录 README.md。</span>
            <a
              href={cleanRepoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 wb-accent-text hover:underline"
            >
              <span>打开目标仓库 {repoSlug}</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};

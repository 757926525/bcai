import React, { useState } from 'react';
import {
  BookOpen,
  Check,
  Cloud,
  Copy,
  Database,
  Download,
  ExternalLink,
  FolderGit2,
  HardDrive,
  Plug,
  Rocket,
  Settings,
  X,
} from 'lucide-react';

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
  | 'usage-connectors'
  | 'usage-settings'
  | 'usage-free-models'
  | 'cn-pages-pull'
  | 'pages-upload'
  | 'cf-vercel-docker';

const REPO_DOWNLOAD_FILES: Array<{ key: string; name: string; desc: string }> = [
  { key: 'edgeone.json', name: 'edgeone.json', desc: '腾讯云 EdgeOne Pages 部署配置' },
  { key: 'esa.jsonc', name: 'esa.jsonc', desc: '阿里云 ESA Pages 部署配置' },
  { key: 'wrangler.toml', name: 'wrangler.toml', desc: 'Cloudflare Pages / Workers 绑定配置' },
  { key: '_routes.json', name: '_routes.json', desc: 'Cloudflare Pages 边缘路由规则' },
  { key: 'netlify.toml', name: 'netlify.toml', desc: 'Netlify 部署与路由配置' },
  { key: 'vercel.json', name: 'vercel.json', desc: 'Vercel Serverless 配置' },
  { key: 'schema.sql', name: 'schema.sql', desc: 'D1 / Turso / Neon / Supabase 建表 SQL' },
  { key: 'DEPLOYMENT.md', name: 'docs/DEPLOYMENT.md', desc: '完整部署与使用手册文档' },
];

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
      title: '仓库连接 GITHUB（含 GitLab / Gitee OAuth 与站点 ID 说明）',
      summary: '支持 GitHub、GitLab（含私有部署实例）与 Gitee 码云三平台连接，界面采用分隔线划分为「区域一：OAuth 授权与站点 ID」与「区域二：保存目标仓库地址和 Token 直连」。',
      commands: `# 1. 目标开源仓库默认地址（可随时修改并持久化保存）:
${cleanRepoUrl}

# 2. 区域一 — 连接仓库站点（OAuth 授权与仓库站点 ID）:
- 授权回调地址 (Callback URL): <你的域名>/auth/callback
- 环境变量可选预设:
  APP_URL="https://your-domain.com"
  GITHUB_CLIENT_ID="..."  GITHUB_CLIENT_SECRET="..."
  GITLAB_CLIENT_ID="..."  GITLAB_CLIENT_SECRET="..."
  GITEE_CLIENT_ID="..."   GITEE_CLIENT_SECRET="..."
- 也可直接在「仓库连接 -> 区域一 -> 配置 OAuth 站点凭证」表单填写 Site ID 与 Client ID/Secret 保存即时生效。

# 3. 区域二 — 保存目标仓库地址和 Token 直连:
- 填入仓库地址与平台 Personal Access Token (PAT) 保存连接后，即可读取文件树、切换/新建分支、编辑提交与一键推送整库。`,
      notes: [
        '仓库站点 ID 可用于记录当前工作台绑定的 OAuth App ID 或腾讯云/阿里云/CF 部署站点 ID，方便跨云统一管理。',
        '支持在分支浏览器中点击「进入仓库分支对话」，携带当前文件路径与代码上下文提问 AI，并一键回传推送至目标分支。',
      ],
    },
    'usage-db-bucket': {
      title: '数据库与文件 (D1) — 多数据库与多对象存储桶指南',
      summary: '支持 Cloudflare D1、Turso (libSQL)、Supabase (Postgres)、Neon (Postgres) 与 Upstash Redis 五类数据库，以及 Cloudflare R2、阿里云 OSS、腾讯云 COS、AWS S3、MinIO 等多品牌存储桶。',
      commands: `# 1. 远程多数据库环境变量示例（任选其一，或在「数据库与文件」面板直接填写）:
# Cloudflare D1 HTTP API:
CF_ACCOUNT_ID="32位账号ID"  CF_D1_DATABASE_ID="UUID"  CF_API_TOKEN="含D1:Edit"
# Turso / libSQL:
TURSO_URL="libsql://your-db.turso.io"  TURSO_AUTH_TOKEN="..."
# Supabase (需先执行仓库 schema.sql):
SUPABASE_URL="https://xxx.supabase.co"  SUPABASE_KEY="service_role_or_anon_key"
# Neon Serverless Postgres / Upstash Redis REST:
NEON_CONNECTION_STRING="postgresql://..."
UPSTASH_REDIS_REST_URL="https://xxx.upstash.io"  UPSTASH_REDIS_REST_TOKEN="..."

# 2. 多对象存储桶环境变量示例（面板可直接选厂商预设）:
S3_ENDPOINT="https://oss-cn-hangzhou.aliyuncs.com"   # 或 cos.ap-guangzhou.myqcloud.com / <acc>.r2.cloudflarestorage.com
S3_REGION="cn-hangzhou"                              # R2 填 auto
S3_BUCKET="your-bucket-name"
S3_ADDRESSING_STYLE="virtual"                        # 阿里云OSS/腾讯云COS/AWS 用 virtual；R2/MinIO 用 path`,
      notes: [
        '左侧边栏「新建会话」上方实时显示「数据库 · 存储桶 · 同步历史」三个真实状态灯（手机竖屏也能一眼查看与点击）。',
        '文件列表清晰标注存储位置（Cloudflare D1 / Turso / Supabase / Neon / Upstash / 对象存储桶 / 本地存储），支持上传、下载与删除。',
      ],
    },
    'usage-connectors': {
      title: '连接器中心 & 对话中直接存入代码使用说明',
      summary: '连接器中心统一管理主流网盘（Alist/阿里云盘聚合、WebDAV、OneDrive、Google Drive）、邮箱服务（Resend/SMTP）、部署平台与自定义 Webhook，接入后可在对话内直接存代码。',
      commands: `# 对话存入代码的 2 种方式（连接器接入后即可使用）:
1. 按钮一键存入:
   在 AI 回复的任意代码块右上角点击「存入连接器」，选择目标网盘/邮箱/Webhook，确认文件名与目标目录即可写入。

2. 对话框指令直接触发:
   /save                        -> 自动提取当前会话最新代码块并存入主连接器
   /save src/app.tsx            -> 指定保存文件名
   /存入连接器 server.ts        -> 中文指令触发保存
   "把刚才的代码保存到网盘"     -> 自然语言指令触发保存并输出保存路径确认`,
      notes: [
        'WebDAV / Alist 支持填写默认保存目录（在添加连接器时的“附加配置”栏填写，如 bcai-code）。',
        'Resend 邮箱连接器可将代码直接作为归档邮件发送至指定收件人；Webhook 连接器会 POST JSON 到指定端点。',
      ],
    },
    'usage-settings': {
      title: '外接 API 与系统设置（含全站管理员登录拦截开关）',
      summary: '涵盖外接模型端点接入、全站管理员登录门禁开关、6 款护眼与工程主题配色及手机/电脑布局切换。',
      commands: `# 1. 全站访问限制开关（管理员登录门禁）:
- 位置: 外接 API 与系统设置 ->「管理员安全门禁开关」
- 关闭（默认）: 普通访客无需登录即可使用 AI 编程、绘图与文件对话；管理区需登录解锁。
- 开启后: 全站显示全屏管理员登录拦截界面挡住主界面，未登录用户无法使用任何功能（含后端 /api/chat 与 /api/image 拦截）。

# 2. 外接 API 流式模式:
- 客户端直连 CORS SSE: 适用于 Groq / OpenRouter / DeepSeek / 自定义 OpenAI 兼容网关，零中转延迟。
- 服务端安全代理 SSE: 适用于环境变量注入的 Gemini / Workers AI / 内置模型，前端不暴露密钥。`,
      notes: [
        '会话「暂停 / 恢复」按键已精简至主界面右上角，彻底腾出对话框上方空间以优化手机观看体验。',
        '管理员可使用后台环境变量 ACCESS_PASSWORD 或面板内自设密码登录；支持随时修改与清除动态密码。',
      ],
    },
    'usage-free-models': {
      title: '免费模型与接入指南（CF Workers AI / Gemini / Groq / OpenRouter）',
      summary: '内置工作台优先模型与免费扩展区，支持无卡零成本部署与极速推理。',
      commands: `# 1. Cloudflare Workers AI（原生免费）:
- 免费额度: 每日 10,000 Neurons
- 推荐模型: @cf/meta/llama-4-scout-17b-16e-instruct (支持看图)
            @cf/qwen/qwen2.5-coder-32b-instruct (编程专精)
            @cf/black-forest-labs/flux-1-schnell (免费文生图)

# 2. Google Gemini Free Tier:
- 推荐模型: gemini-3.1-flash-lite / gemini-2.5-flash (1M 上下文)

# 3. 免费 OpenAI 兼容端点（可直接填入「新增外接 API」）:
- Groq Cloud:   https://api.groq.com/openai/v1 (最高 14,400 RPD)
- OpenRouter:   https://openrouter.ai/api/v1 (选择带 :free 后缀模型)
- Cerebras:     https://api.cerebras.ai/v1
- 硅基流动:     https://api.siliconflow.cn/v1 (免费 7B/9B 开源模型)
- GitHub Models: https://models.inference.ai.azure.com`,
      notes: [
        '所有模型端点在下拉选单均显示实时真实连接状态灯（绿/红/灰），绝不虚假显示连通。',
        '在「设置 -> 免费模型与接入指南」标签页可直接点击对应平台官网链接申请免费 API Key。',
      ],
    },
    'cn-pages-pull': {
      title: '腾讯云 EdgeOne Pages & 阿里云 ESA Pages 拉取部署指南',
      summary: `仓库根目录已内置 edgeone.json 与 esa.jsonc 配置文件，将代码推送至 ${cleanRepoUrl} 后可在腾讯云或阿里云 Pages 控制台直接拉取构建部署。`,
      commands: `# 一、腾讯云 EdgeOne Pages 拉取部署（自动读取 edgeone.json）:
1. 登录 腾讯云 EdgeOne 控制台 -> Pages -> 新建项目 -> 导入 Git 仓库 (${repoSlug})
2. 构建配置（默认自动识别 edgeone.json）:
   - 构建命令: npm run build:pages
   - 输出目录: dist-pages
3. 环境变量添加: APP_URL, ACCESS_PASSWORD, GEMINI_API_KEY（及 Turso/Supabase/OSS/COS 变量）

# 二、阿里云 ESA Pages 拉取部署（自动读取 esa.jsonc）:
1. 登录 阿里云 ESA 控制台 -> Pages -> 创建项目 -> 绑定 GitHub/GitLab/Gitee 仓库
2. 构建配置（自动匹配 esa.jsonc）:
   - 构建命令: npm run build:pages
   - 静态目录: dist-pages  |  边缘函数路由: /api/* -> /_worker.js
3. 环境变量按需配置后点击部署，每次 git push 自动触发增量构建。`,
      notes: [
        '执行 npm run build:pages 会自动构建前端 dist/ 并用 esbuild 将边缘服务端打包为 dist-pages/_worker.js，同时复制多云配置文件。',
        '国内云厂商部署建议搭配阿里云 OSS / 腾讯云 COS（Virtual-Hosted 模式）以及 Turso / Neon / Supabase HTTP 数据库。',
      ],
    },
    'pages-upload': {
      title: '上传 Pages 部署（直接下载仓库内可用部署文件）',
      summary: '无需自行手动编写配置，可直接下载下方仓库内置的各云厂商部署文件，或在本地执行 npm run build:pages 生成 dist-pages/ 目录后上传至 Cloudflare / 腾讯云 EdgeOne / 阿里云 ESA Pages。',
      commands: `# 本地生成多平台上传部署包目录 (dist-pages/):
npm ci
npm run build:pages

# 产物内容（已自动打包全部所需文件）:
#   dist-pages/index.html + assets/   -> 前端静态资源
#   dist-pages/_worker.js             -> 全栈边缘后端（含多DB/多S3/OAuth/AI代理）
#   dist-pages/edgeone.json           -> 腾讯云 EdgeOne Pages 配置
#   dist-pages/esa.jsonc              -> 阿里云 ESA Pages 配置
#   dist-pages/wrangler.toml          -> Cloudflare Pages 绑定配置
#   dist-pages/_routes.json           -> Cloudflare 路由规则
#   dist-pages/schema.sql             -> 数据库建表 SQL

# Cloudflare Wrangler CLI 直接上传示例:
npx wrangler pages deploy dist-pages --project-name=bcai`,
      notes: [
        '腾讯云 EdgeOne Pages / 阿里云 ESA Pages「直接上传」入口支持上传 dist-pages/ 目录或其打包后的压缩包。',
        '下方「仓库内直接可用部署文件下载」卡片可一键单独下载任意配置文件或完整 Pages 上传包 (.zip)。',
      ],
    },
    'cf-vercel-docker': {
      title: 'Cloudflare Pages / Vercel / Netlify / Docker / Linux VPS 部署',
      summary: `仓库同时原生兼容 Cloudflare Pages、Vercel、Netlify、Docker Compose 与 Linux Node.js 22+ VPS。`,
      commands: `# 1. Cloudflare Pages (Git 拉取):
Framework: Vite | Build: npm run build | Output: dist
Bindings: AI (Workers AI), DB (D1), BUCKET (R2)

# 2. Vercel / Netlify (自动读取 vercel.json / netlify.toml):
vercel --prod   # 或在控制台导入 ${cleanRepoUrl}

# 3. Docker Compose (推荐 VPS 一键部署):
git clone ${cleanRepoUrl}.git && cd ${repoSlug.split('/').pop() || 'bcai'}
cp .env.example .env
docker compose up -d --build

# 4. Linux VPS 原生运行 (Node.js 22+):
npm ci && npm run build
npx pm2 start "NODE_ENV=production node server.ts" --name bcai`,
      notes: [
        '使用 Nginx 反向代理 Node.js 服务时请配置 proxy_buffering off; 与 proxy_cache off; 以保障流式 SSE 实时到达。',
        'Docker 与 VPS 模式支持未绑定远程库时自动持久化至 .data/ 目录。',
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
      <div className="w-full max-w-5xl max-h-[92vh] flex flex-col rounded-xl border wb-border wb-panel shadow-xl overflow-hidden">
        <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b wb-border gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <Rocket className="w-5 h-5 wb-accent-text shrink-0" />
            <div className="min-w-0">
              <h2 className="text-base sm:text-lg font-semibold wb-ink">部署和使用中心</h2>
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
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenGitHubTab();
              }}
              className="h-9 px-3.5 rounded-lg border wb-border wb-panel text-xs font-medium wb-ink inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <FolderGit2 className="w-3.5 h-3.5" />
              <span>打开仓库协同</span>
            </button>
          </div>

          {/* Guide Section Switcher */}
          <div className="flex flex-wrap gap-1.5 p-1.5 rounded-xl wb-bg border wb-border">
            {(
              [
                ['usage-repo', '仓库连接 GITHUB', FolderGit2],
                ['usage-db-bucket', '数据库与文件 (D1)', Database],
                ['usage-connectors', '连接器中心', Plug],
                ['usage-settings', '外接 API 与系统设置', Settings],
                ['usage-free-models', '免费模型与接入指南', BookOpen],
                ['cn-pages-pull', '腾讯/阿里 Pages 拉取', Cloud],
                ['pages-upload', '上传 Pages 部署', HardDrive],
                ['cf-vercel-docker', 'CF/Vercel/Docker/VPS', Rocket],
              ] as Array<[GuideTabKey, string, React.ComponentType<{ className?: string }>]>
            ).map(([key, label, Icon]) => (
              <button
                key={key}
                type="button"
                onClick={() => setPlatform(key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors inline-flex items-center gap-1.5 whitespace-nowrap ${
                  platform === key ? 'wb-panel wb-ink shadow-sm' : 'wb-muted hover:wb-ink'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{label}</span>
              </button>
            ))}
          </div>

          {/* Active Guide */}
          <div className="rounded-xl border wb-border p-4 space-y-3.5">
            <h3 className="text-sm font-semibold wb-ink">{active.title}</h3>
            <p className="text-xs wb-muted leading-relaxed">{active.summary}</p>

            <div className="rounded-lg border wb-border wb-bg overflow-hidden">
              <div className="flex items-center justify-between px-3 py-1.5 border-b wb-border text-xs wb-muted">
                <span>详细步骤、配置参数与参考命令</span>
                <button
                  type="button"
                  onClick={copyCommands}
                  className="inline-flex items-center gap-1 wb-ink hover:wb-accent-text"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copied ? '已复制' : '复制内容'}</span>
                </button>
              </div>
              <pre className="p-3.5 text-xs font-mono wb-ink overflow-x-auto leading-relaxed whitespace-pre-wrap">
                <code>{active.commands}</code>
              </pre>
            </div>

            <ul className="space-y-1.5 text-xs wb-muted">
              {active.notes.map((n, i) => (
                <li key={i}>• {n}</li>
              ))}
            </ul>

            {/* Repository Ready-to-Deploy Downloadable Files inside Upload Pages Tab */}
            {platform === 'pages-upload' && (
              <div className="pt-3 border-t wb-border space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-semibold wb-ink">
                    仓库内直接可用部署文件下载（适用于上传 Pages / 初始化数据库）
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <a
                      href="/api/deploy/pages-package.zip"
                      download="bcai-pages-upload-bundle.zip"
                      className="h-8 px-3 rounded-lg wb-accent text-xs font-medium inline-flex items-center gap-1.5"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>下载 Pages 上传成品包 (.zip)</span>
                    </a>
                    <a
                      href="/api/deploy/source-package.zip"
                      download="bcai-full-source.zip"
                      className="h-8 px-3 rounded-lg border wb-border wb-panel text-xs font-medium wb-ink inline-flex items-center gap-1.5"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>下载完整源码 (.zip)</span>
                    </a>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                  {REPO_DOWNLOAD_FILES.map((f) => (
                    <a
                      key={f.key}
                      href={`/api/deploy/repo-file?name=${encodeURIComponent(f.key)}`}
                      download={f.name.split('/').pop()}
                      className="p-2.5 rounded-lg border wb-border wb-bg hover:border-blue-500 transition-colors flex items-start justify-between gap-2"
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-mono font-medium wb-ink truncate">{f.name}</div>
                        <div className="text-[11px] wb-muted truncate mt-0.5">{f.desc}</div>
                      </div>
                      <Download className="w-3.5 h-3.5 wb-accent-text shrink-0 mt-0.5" />
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs wb-muted pt-1">
            <span>完整部署文档已同步保存在仓库 README.md 与 docs/DEPLOYMENT.md。</span>
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

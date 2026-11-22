# BCAI AI 工作台 — 全平台部署与使用手册

本文档提供 **仓库连接 (GitHub/GitLab/Gitee)**、**多数据库与多存储桶**、**连接器中心与对话存代码**、**外接 API 与全站门禁设置**、**免费模型接入**，以及 **Cloudflare Pages / 腾讯云 EdgeOne Pages / 阿里云 ESA Pages / Vercel / Netlify / Docker / Linux VPS** 的详细拉取与上传部署教程。

---

## 一、仓库直接可用部署文件清单

仓库根目录已内置各云厂商标准配置文件与打包脚本，拉取部署自动识别，也可直接下载用于上传部署：

| 文件名 | 适用平台 | 用途说明 |
| --- | --- | --- |
| `wrangler.toml` | Cloudflare Pages / Workers | 声明 `AI`（Workers AI）、`DB`（D1）、`BUCKET`（R2）绑定与默认环境变量 |
| `_routes.json` | Cloudflare Pages Functions | 路由转发规则（静态资源直出，`/api/*` 与 `/auth/callback` 走边缘函数） |
| `edgeone.json` | **腾讯云 EdgeOne Pages** | 构建命令 `npm run build:pages`、输出目录 `dist-pages` 及接口重写规则 |
| `esa.jsonc` | **阿里云 ESA Pages** | 构建命令 `npm run build:pages`、SPA 回退及 `/api/*` `_worker.js` 边缘函数映射 |
| `netlify.toml` | Netlify | 构建命令 `npm run build`、发布目录 `dist` 与 SPA 重定向 |
| `vercel.json` | Vercel | Serverless Function `/api/index.ts` 与前端静态输出路由 |
| `schema.sql` | D1 / Turso / Neon / Supabase | `conversations`、`media_assets`、`admin_settings` 初始化建表 SQL |
| `scripts/build-pages-bundle.mjs` | 上传部署打包脚本 | 运行 `npm run build:pages` 一键输出可上传目录 `dist-pages/`（含 `_worker.js` 与配置文件） |
| `Dockerfile` / `docker-compose.yml` | Docker / 云服务器 | 多阶段容器镜像与 `.data/` 持久化卷配置 |

---

## 二、多平台部署指南

### 1. Cloudflare Pages 部署（Git 拉取 & 上传部署）

#### 方式 A：Git 拉取自动部署（推荐）
1. 将代码推送到你的 GitHub / GitLab 仓库（可在工作台「仓库连接」一键推送）。
2. 登录 Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**。
3. 填写构建配置：
   - **Framework preset**: `Vite`
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
4. 在 **Settings → Functions → Bindings** 绑定原生资源（免费且无需 API Token）：
   - **Workers AI**: 变量名填 `AI`
   - **D1 Database**: 变量名填 `DB`（首次使用执行 `npx wrangler d1 execute bcai-db --remote --file=./schema.sql`）
   - **R2 Bucket（可选）**: 变量名填 `BUCKET`
5. 在 **Settings → Environment variables** 添加：`ACCESS_PASSWORD`、`GEMINI_API_KEY`、`APP_URL`（站点公网域名，用于 OAuth 回调）。

#### 方式 B：上传部署（Direct Upload）
```bash
npm ci
npm run build:pages
# 方式1：CLI 上传 dist-pages 目录
npx wrangler pages deploy dist-pages --project-name=bcai
# 方式2：在 Cloudflare Pages 控制台上传 dist-pages/ 或界面内下载的部署包
```

---

### 2. 腾讯云 EdgeOne Pages 部署（Git 拉取 & 上传部署）

仓库已提供 `edgeone.json`，支持以下两种部署方式：

#### 方式 A：Git 拉取部署（Webify / EdgeOne Pages）
1. 打开 **腾讯云控制台 → EdgeOne Pages** → 新建项目 → 选择「导入 Git 仓库」。
2. EdgeOne 会自动读取仓库根目录 `edgeone.json`：
   - **构建命令**: `npm run build:pages`
   - **输出目录**: `dist-pages`
   - **Node.js 版本**: 建议选择 `20.x` 或 `22.x`
3. 在项目「环境变量」中配置：
   - `APP_URL`: 你的 EdgeOne 站点域名（例如 `https://bcai.edgeone.app`）
   - `ACCESS_PASSWORD`: 管理员密码
   - `GEMINI_API_KEY` / `DEEPSEEK_API_KEY` / `GROQ_API_KEY`
   - 若使用远程数据库（如 Turso / Supabase / Neon / D1 HTTP），填入对应连接变量。
4. 点击「立即部署」，后续每次推送代码将自动拉取重新构建。

#### 方式 B：本地构建后上传部署（Upload）
```bash
npm ci
npm run build:pages
```
将生成的 `dist-pages/` 文件夹打包或直接上传至 EdgeOne Pages「直接上传部署」入口（或在工作台 **部署和使用 → 上传 Pages 部署** 中直接下载配置文件与压缩包上传）。

---

### 3. 阿里云 ESA Pages 部署（Git 拉取 & 上传部署）

仓库根目录已提供 `esa.jsonc`，支持 Git 拉取与上传部署：

#### 方式 A：Git 拉取部署（阿里云边缘安全加速 ESA Pages）
1. 登录 **阿里云控制台 → 边缘安全加速 ESA → Pages** → 点击「创建项目」并绑定 GitHub / GitLab / Gitee 仓库。
2. 构建配置（自动匹配 `esa.jsonc`）：
   - **构建命令**: `npm run build:pages`
   - **静态资源目录**: `dist-pages`
   - **边缘函数入口**: `dist-pages/_worker.js`（已在 `esa.jsonc` 中将 `/api/*` 与 `/auth/callback*` 路由至 `/_worker.js`）
3. 配置环境变量：`APP_URL`、`ACCESS_PASSWORD`、`GEMINI_API_KEY` 及外部数据库/存储桶变量（如阿里云 OSS 的 `S3_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com`、`S3_ADDRESSING_STYLE=virtual`）。

#### 方式 B：上传 Pages 部署
1. 执行 `npm run build:pages` 生成 `dist-pages/`（内含编译好的前端、`esa.jsonc` 与 `_worker.js`）。
2. 在 ESA Pages 控制台选择「本地上传 / CLI 上传」，提交 `dist-pages/` 目录即可上线。
3. 若使用阿里云函数计算 FC / 容器部署全栈 Node 版，可直接运行 `Dockerfile`。

---

### 4. Vercel / Netlify / Docker / Linux VPS 部署

- **Vercel**：导入仓库即可（根目录 `vercel.json` 与 `api/index.ts` 已就绪），或在本地执行 `vercel --prod`。
- **Netlify**：导入仓库即可（根目录 `netlify.toml` 已配置 `npm run build` 与 `dist` 发布目录）。
- **Docker Compose**：
  ```bash
  cp .env.example .env
  docker compose up -d --build
  ```
- **Linux VPS (Node.js 22+)**：
  ```bash
  npm ci && npm run build
  NODE_ENV=production node server.ts
  ```
  Nginx 反向代理流式对话时请务必添加：`proxy_buffering off;` 与 `proxy_cache off;`。

---

## 三、五大核心模块详细使用说明

### 1. 仓库连接 GITHUB（含 GitLab / Gitee OAuth 与站点 ID）
- **分区一：连接仓库站点（OAuth 授权与仓库站点 ID）**
  - 支持 GitHub、GitLab（含私有部署实例 URL）与 Gitee 码云三平台 OAuth 弹窗授权。
  - **仓库站点 ID 部署与使用说明**：
    1. **OAuth 应用站点 ID（Client ID / App ID）**：前往 GitHub Developer Settings（OAuth Apps）、GitLab Applications 或 Gitee 第三方应用创建应用，将授权回调地址设为 `https://<你的域名>/auth/callback`。
    2. **云平台站点 / 项目 ID（Site ID）**：若你同时接入了 Cloudflare Pages / Netlify / EdgeOne / ESA 等部署平台，可在「仓库站点 ID」字段记录该部署站点 ID，方便跨平台识别当前工作台绑定的仓库与部署站点。
    3. 填入 Client ID 与 Client Secret 点击「保存站点 OAuth 配置」后，即可直接点击「OAuth 授权登录」完成账号绑定（无需重启服务）。
- **分区二：保存目标仓库地址和 Token 实现直连**
  - 当暂不配置 OAuth 应用时，可直接在下方分隔区填写目标仓库地址（如 `https://github.com/757926525/bcai`）和平台 Personal Access Token（PAT），保存后立即载入仓库文件树与分支，支持在线编辑提交及一键推送整库源码。

### 2. 数据库与文件 (D1) — 多数据库 & 多存储桶
- **支持 5 类远程数据库**（未绑定时自动回退本地 `.data/bcai-db.json`）：
  1. **Cloudflare D1**：Pages 原生 `env.DB` 或填写 `Account ID + Database UUID + API Token` 自动建表。
  2. **Turso (libSQL)**：填写 `libsql://` 或 `https://` URL 与 Auth Token，自动建表。
  3. **Supabase (Postgres REST)**：填写 Project URL 与 `service_role` / `anon` Key（需先在 Supabase SQL Editor 运行 `schema.sql`）。
  4. **Neon (Serverless Postgres)**：填写 PostgreSQL 连接串，通过 HTTPS `/sql` 接口自动建表。
  5. **Upstash Redis REST**：填写 REST URL 与 REST Token，支持极速 KV 持久化。
- **支持 6 类 S3 兼容对象存储桶**：
  - **Cloudflare R2**（Path Style，`region=auto`）
  - **阿里云 OSS**（Virtual-Hosted Style，如 `https://oss-cn-hangzhou.aliyuncs.com`）
  - **腾讯云 COS**（Virtual-Hosted Style，如 `https://cos.ap-guangzhou.myqcloud.com`）
  - **AWS S3 / MinIO / Backblaze B2 / 七牛云 Kodo S3**
- 左侧边栏「新建会话」上方实时显示 **数据库 · 存储桶 · 同步历史** 三个真实状态灯，点击即可快速配置与双向同步。

### 3. 连接器中心（与对话存代码联动）
- 支持接入 **主流网盘**（Alist / 阿里云盘聚合、WebDAV 坚果云/Nextcloud/123云盘、Microsoft OneDrive、Google Drive）、**邮箱服务**（Resend、SMTP Webhook）、**部署平台**（Cloudflare、Vercel、Netlify）及自定义 Webhook。
- **在对话中直接存入代码到连接器**：
  1. 方式一（按钮一键存入）：AI 回复中的每个代码块右上角均提供 **「存入连接器」** 按钮，点击可选择已接入的网盘/邮箱/Webhook 并自定义文件名与目录路径。
  2. 方式二（对话指令触发）：在已有代码生成的对话中，直接发送 `/save`、`/存入连接器` 或「把刚才的代码存入连接器/网盘」，工作台会自动提取最近生成的代码并写入你默认或指定的连接器，随后在对话中返回写入路径确认消息。

### 4. 外接 API 与系统设置（含全站管理员登录门禁）
- **全站访问限制开关（管理员登录拦截）**：
  - 在「外接 API 与系统设置 → 管理员安全设置」中开启后，未登录管理员的访客将被全屏登录界面拦截，无法使用 AI 对话、编程与绘图功能，且后端 `/api/chat`、`/api/image`、`/api/providers/probe` 同步强制校验管理员会话。
  - 关闭时恢复默认开放模式：普通访客可免登录使用前端 AI 能力，仅管理区需要登录。
- **外接模型端点**：支持环境变量注入或前端新增 OpenAI 兼容 / DeepSeek / Groq / OpenRouter / Gemini / Workers AI 端点，并支持客户端 CORS SSE 直连或后端代理流式。

### 5. 免费模型与接入指南
- **Cloudflare Workers AI**：绑定 `env.AI` 或 `CF_ACCOUNT_ID + CF_API_TOKEN` 享每日 **10,000 Neurons** 免费额度（Llama 4 Scout、Llama 3.3 70B、Qwen2.5 Coder 32B、DeepSeek R1 32B、FLUX.1 Schnell 绘图）。
- **Google Gemini**：免费层支持最高 1M 上下文（`gemini-3.1-flash-lite`、`gemini-2.5-flash` 等），配置 `GEMINI_API_KEY`。
- **Groq Cloud**：极速推理，免费层最高 14,400 请求/天，支持直连流式。
- **OpenRouter (`:free` 模型)**：包含大量 `:free` 零费率开源大模型。
- **DeepSeek / GitHub Models / Cerebras / 硅基流动**：均支持在「设置 → 新增外接 API」中配置端点与模型 ID 后即时探测状态灯并加入模型选区。

# BCAI AI 工作台（AIMX 升级版）

集 **AI 编程区**、**AI 绘图区（含负向提示词与完整参数区）**、**多模态图文/文件流式对话**、**多数据库（D1 / Turso / Supabase / Neon / Upstash）与多存储桶（R2 / 阿里云 OSS / 腾讯云 COS / S3 / MinIO）双通道同步**、**GitHub / GitLab / Gitee OAuth 与分支协同**、**连接器中心（支持对话直接存入代码）** 与 **多云 Pages 拉取/上传一键部署** 于一体的开源全栈工作台。

默认开源目标仓库：`https://github.com/757926525/bcai`（支持界面实时修改并持久化保存）。

> 完整图文与命令行运维步骤请查阅：[`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md)

---

## 核心功能亮点

1. **双区直观仓库授权（OAuth 授权 + 站点 ID ｜ 目标仓库地址与 Token 直连）**
   - 支持 **GitHub / GitLab（含私有实例）/ Gitee 码云** 弹窗 OAuth 授权登录，并在界面内提供 **仓库站点 ID（OAuth Client ID / 部署站点 ID）** 配置与部署使用说明。
   - 使用分隔线将「连接仓库站点（OAuth）」与「保存目标仓库地址和 Token 实现直连」清晰划分为两大区域，支持单文件读写、新建分支与整库原子推送。

2. **多数据库 & 多对象存储桶自由切换**
   - **数据库支持**：Cloudflare D1（原生 `env.DB` 与 HTTP API）、Turso / libSQL、Supabase PostgREST、Neon Serverless Postgres、Upstash Redis REST，以及本地 `.data/bcai-db.json` 回退。
   - **存储桶支持**：Cloudflare R2、阿里云 OSS、腾讯云 COS、AWS S3、MinIO、Backblaze B2 / 七牛云（自动适配 Path / Virtual-Hosted 签名模式）。
   - **手机端优化**：`(数据库 · 存储桶 · 同步历史)` 三灯状态栏位于侧边栏 **「新建会话」** 按键上方；会话 **「暂停/恢复」** 仅保留在顶部右上角，彻底释放手机端对话视野。

3. **连接器中心 & 对话直接存代码**
   - 支持 Alist/阿里云盘、WebDAV、OneDrive、Google Drive、Resend 邮箱、Cloudflare/Vercel/Netlify 与自定义 Webhook。
   - 连接器接入后，可在对话代码块点击 **「存入连接器」**，或直接在对话发送 `/save` / `/存入连接器` 指令将生成的代码直接写入网盘或推送至 Webhook。

4. **全站管理员登录拦截开关 & 分级权限**
   - 支持在 **外接 API 与系统设置** 中一键开启/关闭 **全站访问限制（登录门禁）**：开启后未登录访客将被全屏登录界面阻挡，仅管理员可使用全部工作台能力。

5. **多云 Pages 拉取部署 & 仓库内置可下载部署文件**
   - 仓库内直接提供 `edgeone.json`（腾讯云 EdgeOne Pages）、`esa.jsonc`（阿里云 ESA Pages）、`wrangler.toml` & `_routes.json`（Cloudflare Pages）、`netlify.toml`、`vercel.json`、`schema.sql` 与 `npm run build:pages` 打包脚本（输出可直接上传的 `dist-pages/`）。

---

## 快速部署方式汇总

### 1. 腾讯云 EdgeOne Pages / 阿里云 ESA Pages / Cloudflare Pages 拉取部署
- 将本仓库推送至 GitHub / GitLab / Gitee 后，在对应云平台导入仓库：
  - **腾讯云 EdgeOne Pages**：自动读取 `edgeone.json`（构建命令 `npm run build:pages`，输出目录 `dist-pages`）。
  - **阿里云 ESA Pages**：自动读取 `esa.jsonc`（构建命令 `npm run build:pages`，静态目录 `dist-pages`，边缘路由 `_worker.js`）。
  - **Cloudflare Pages**：Framework 选择 `Vite`，构建命令 `npm run build`，输出目录 `dist`，并在 Functions 绑定 `AI` / `DB` / `BUCKET`。

### 2. 上传 Pages 部署（直接生成可用文件）
```bash
npm ci
npm run build:pages
```
命令执行完成后，根目录将生成 `dist-pages/` 文件夹（内含编译好的前端、`wrangler.toml`、`_routes.json`、`edgeone.json`、`esa.jsonc`、`netlify.toml`、`schema.sql` 以及打包好的 `_worker.js`），直接上传该目录或通过 `npx wrangler pages deploy dist-pages` 即可上线。也可在工作台「部署和使用 → 上传 Pages 部署」直接单独下载这些配置文件。

### 3. Vercel / Docker / Linux VPS 部署
```bash
git clone https://github.com/757926525/bcai.git
cd bcai
cp .env.example .env
# 方式 A：Docker Compose
docker compose up -d --build

# 方式 B：Node.js 22+ 原生运行
npm ci && npm run build
NODE_ENV=production node server.ts
```

---

## 环境变量说明（`.env.example`）

| 变量名 | 说明 |
| --- | --- |
| `ACCESS_PASSWORD` | 管理员登录密码（设置后可直接登录管理区或通过登录门禁） |
| `APP_URL` | 站点公网访问地址（用于 GitHub / GitLab / Gitee OAuth 回调） |
| `TARGET_REPO_URL` | 自定义默认开源目标仓库（默认 `https://github.com/757926525/bcai`） |
| `GEMINI_API_KEY` | Google Gemini 服务端密钥 |
| `CF_ACCOUNT_ID` / `CF_API_TOKEN` / `CF_D1_DATABASE_ID` | Cloudflare Workers AI 与 D1 HTTP API 凭证 |
| `TURSO_URL` / `TURSO_AUTH_TOKEN` | Turso / libSQL 远程数据库 |
| `SUPABASE_URL` / `SUPABASE_KEY` | Supabase PostgREST 数据库 |
| `NEON_CONNECTION_STRING` | Neon Serverless Postgres 连接串 |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST 数据库 |
| `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_ADDRESSING_STYLE` | R2 / 阿里云 OSS / 腾讯云 COS / AWS S3 / MinIO 对象存储配置 |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `GITHUB_TOKEN` | GitHub OAuth 应用凭证或 PAT |
| `GITLAB_CLIENT_ID` / `GITLAB_CLIENT_SECRET` / `GITLAB_TOKEN` | GitLab OAuth 应用凭证或 PAT |
| `GITEE_CLIENT_ID` / `GITEE_CLIENT_SECRET` / `GITEE_TOKEN` | Gitee 码云 OAuth 应用凭证或 PAT |
| `DEEPSEEK_API_KEY` / `GROQ_API_KEY` / `OPENROUTER_API_KEY` / `OPENAI_API_KEY` | 免费及外接大模型 API Key |

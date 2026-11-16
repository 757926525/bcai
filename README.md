# BCAI 工作台（编程 · 绘图 · 多免费模型 · D1 存储 · GitHub 分支协同）

项目仓库地址：`https://github.com/757926525/aimx`

AIMX 是一个开源、可直接拉取部署的全栈 AI 编程与绘图工作台，原生兼容 **Cloudflare Pages + Workers AI + D1 数据库**，同时也支持 **Vercel**、**Docker**、**Linux 服务器 / VPS** 一键部署。

---

## 一、主要功能介绍

1. **双大模型选区架构**
   - **选区一（内置工作台选区 · 保留原样）**：保留经典 Cloudflare Workers AI 对话、编程与绘图模型（Llama 3.3 70B、Qwen2.5 Coder 32B、DeepSeek R1 Distill 32B、Gemma 3 12B、Mistral Small 3.1 24B、Llama 3.1 8B 及 FLUX.1 schnell / SDXL 等绘图模型）。
   - **选区二（免费扩展与外接模型选区 · 标明免费）**：内置 Cloudflare Workers AI 免费项、Google Gemini、DeepSeek、Groq、OpenRouter / GitHub Models 等 OpenAI 兼容免费端点，并标明各自的免费额度与速率限制。
2. **外接 API 自由管理 & 客户端安全流式直连**
   - 支持**后端环境变量注入**与**前端本地保存**两种方式自由添加、编辑、删除外接 API 与自定义模型列表。
   - 支持**客户端直连 HTTPS 流式交互 (SSE)**（浏览器直接请求 CORS 兼容端点，密钥无需经过中转服务器）与**服务端代理流式**混合路由。
3. **真实有效的连接状态灯**
   - 每个模型和提供方均显示真实实时探活状态（`未配置` / `检测中` / `已连接` / `异常`）及实测延迟（ms），未配置或未验证通过绝不显示绿灯。
4. **计划登录面板 & 会话全生命周期控制**
   - 提供工作区计划/登录面板（支持 `ACCESS_PASSWORD` 访问解锁、GitHub OAuth 账号连接、本地免费模式）。
   - 支持多会话切换、删除历史对话、**暂停/恢复会话**、中断生成后保留已生成内容继续续写，并完整记录**每条对话与会话的时间戳**。
5. **Cloudflare D1 优先的图片与文件数据库绑定**
   - 优先支持原生 `env.DB`（Cloudflare Pages D1 绑定）以及远程 D1 HTTP API（Account ID + Database ID + API Token）。
   - 在无 D1 环境下自动回退到本地持久化存储（`.data/aimx-db.json`），支持图片生成入库、代码文件保存、**保存时间记录**与预览下载。
6. **GitHub 仓库授权连接、文件读写与分支推送**
   - 支持跳转 GitHub OAuth 授权登录或 PAT 令牌连接并保存连接状态。
   - 自由切换个人仓库与分支，**对话框顶部实时显示当前仓库与分支**。
   - 支持读取仓库目录树与文件内容直接加入 AI 编程上下文，支持修改文件、**新建分支**并**提交推送 (Commit & Push)**。
7. **多平台部署与 Pages 上传包下载**
   - 内置部署中心，可直接下载预打包的 **Cloudflare Pages 上传部署包 (`.zip`)**，并附带全部平台配置模板。

---

## 二、环境变量说明

| 变量名 | 必填 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `GEMINI_API_KEY` | 否 | - | Google AI Studio / Gemini API 密钥（服务端 `@google/genai` 调用） |
| `ACCESS_PASSWORD` | 否 | - | 工作台访问密码（设置后登录面板需验证密码） |
| `CF_ACCOUNT_ID` | 否 | - | Cloudflare 账户 ID（用于远程调用 Workers AI 与 D1 HTTP API） |
| `CF_API_TOKEN` | 否 | - | Cloudflare API Token（需具备 Workers AI Read/Edit 与 D1 Edit 权限） |
| `CF_D1_DATABASE_ID` | 否 | - | Cloudflare D1 数据库 UUID（在独立 Node/Docker 模式下使用 D1 时填写） |
| `DEEPSEEK_API_KEY` | 否 | - | DeepSeek API 密钥（后端注入，也可直接在前端设置页添加） |
| `DEEPSEEK_BASE_URL` | 否 | `https://api.deepseek.com/v1` | DeepSeek OpenAI 兼容接口地址 |
| `GROQ_API_KEY` | 否 | - | Groq 免费高速推理 API 密钥 |
| `GROQ_BASE_URL` | 否 | `https://api.groq.com/openai/v1` | Groq OpenAI 兼容接口地址 |
| `OPENROUTER_API_KEY` | 否 | - | OpenRouter API 密钥（可调用 `:free` 免费模型） |
| `OPENAI_API_KEY` | 否 | - | 通用 OpenAI 兼容端点密钥 |
| `OPENAI_BASE_URL` | 否 | `https://api.openai.com/v1` | 通用 OpenAI 兼容端点 Base URL |
| `OPENAI_MODELS` | 否 | `gpt-4o-mini` | 逗号分隔的模型列表，自动加入到选区 |
| `GITHUB_CLIENT_ID` | 否 | - | GitHub OAuth App Client ID |
| `GITHUB_CLIENT_SECRET` | 否 | - | GitHub OAuth App Client Secret |
| `APP_URL` | 否 | `http://localhost:3000` | 应用对外访问完整 URL（用于拼装 GitHub OAuth 回调地址 `/auth/callback`） |

> 在 **Cloudflare Pages** 环境中，还需在 Pages Settings -> Functions 中绑定：
> - **Workers AI 绑定**：变量名 `AI`
> - **D1 数据库绑定**：变量名 `DB`（建表 SQL 见 `schema.sql`）

---

## 三、多平台部署指南

### 1. Cloudflare Pages 上传部署（Direct Upload）
1. 在应用内点击左侧 **部署中心** -> **下载 Cloudflare Pages 上传部署包 (.zip)**（或本地执行 `npm run build` 后打包 `dist/`、`functions/`、`_routes.json`）。
2. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/) -> **Workers & Pages** -> **Create** -> **Pages** -> **Upload assets**。
3. 上传解压后的静态资源与 `functions/` 目录（或使用 Wrangler CLI）：
   ```bash
   npm run build
   npx wrangler pages deploy dist --project-name=aimx
   ```
4. 在 Pages 项目 **Settings -> Functions** 绑定 `AI` (Workers AI) 与 `DB` (D1 Database)，并执行：
   ```bash
   npx wrangler d1 execute aimx-db --remote --file=./schema.sql
   ```

### 2. Cloudflare Pages 拉取部署（Git Pull）
1. 将代码推送到你的 GitHub 仓库（如 `https://github.com/757926525/aimx`）。
2. 在 Cloudflare Dashboard -> **Workers & Pages** -> **Connect to Git** 选择该仓库。
3. 构建设置：
   - **Framework preset**: `Vite`
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
4. 添加环境变量（如 `GEMINI_API_KEY`、`GITHUB_CLIENT_ID` 等）并绑定 `AI` 与 `DB`。

### 3. Vercel 部署
1. 在 [Vercel](https://vercel.com/new) 导入 GitHub 仓库 `757926525/aimx`。
2. `vercel.json` 已预配置好构建命令与路由重写。
3. 在 Vercel Project Settings -> Environment Variables 中填入所需的环境变量（如 `GEMINI_API_KEY`、`CF_ACCOUNT_ID`、`CF_API_TOKEN`、`CF_D1_DATABASE_ID` 等）。

### 4. Docker / Docker Compose 部署
```bash
git clone https://github.com/757926525/aimx.git
cd aimx
cp .env.example .env
# 编辑 .env 填入你的 API Key 或 Cloudflare D1 凭证
docker compose up -d --build
```
访问 `http://你的服务器IP:3000`。本地数据持久化在 `aimx_data` 卷中。

### 5. 独立服务器 / VPS 部署（Node.js 20+ / PM2 / Nginx）
```bash
git clone https://github.com/757926525/aimx.git
cd aimx
npm ci
cp .env.example .env
npm run build
# 使用 PM2 守护运行在 3000 端口
npx pm2 start "npx tsx server.ts" --name aimx
```
Nginx 反向代理建议开启 SSE 流式缓冲关闭（`proxy_buffering off;`）以获得流畅的打字机流式体验。

# BCAI AI 工作台（AIMX 升级版）

集 **AI 编程区**、**AI 绘图区（含负向提示词与完整参数区）**、**多模态图文/文件流式对话**、**Cloudflare D1 & R2/S3 存储桶双通道同步**、**GitHub / GitLab / Gitee 多仓库分支协同**、**主流网盘/邮箱/部署连接器** 与 **一键多平台部署** 于一体的开源全栈工作台。

默认开源目标仓库：`https://github.com/757926525/bcai`（支持界面实时修改并持久化保存）。

---

## 核心功能亮点

1. **编程区 & 绘图区双核心布局**
   - **编程区**：代码高亮、块级复制、一键写入数据库、一键发送至 Git 仓库分支、回复内容一键打包为 `.zip`。
   - **绘图区**：支持正向 Prompt + 独立**负向提示词（Negative Prompt）**窗口 + 常用排除词预设、步数（Steps）、CFG 引导系数、Seed 随机种子、自定义尺寸及中英自动翻译；支持保存至 D1 数据库或存储桶。

2. **多模态上传对话 & 聊天底部上拉功能条**
   - 直接上传图片（PNG/JPG/WebP）与源代码/文档（`.ts/.tsx/.py/.md/.json/...`）进行图文/代码联合提问。
   - **对话框底部工具条**：上传文件按钮、下载文件按钮、草稿板、暂停按钮统一位于输入区下方，互不遮挡。
   - **可向上拉动 / 展开的扩展抽屉**：支持触摸上滑与点击展开，平时收起不拥挤；展开可管理附件、临时草稿板、以及打包下载 `.zip` / 多选合并导出对话 `.txt`。

3. **更多内置免费大模型 & 真实连接状态灯**
   - **选区一（内置工作台 · CF Workers AI 免费优先）**：Llama 4 Scout / Maverick（支持看图）、Llama 3.3 70B、Llama 3.2 11B Vision、Qwen2.5 Coder 32B、Qwen2.5 72B、QwQ 32B、DeepSeek R1 32B、Gemma 3 12B、Mistral Small 3.1 24B、Granite 3.1 等。
   - **选区二（免费扩展 & 外接自定义模型）**：Gemini（`gemini-4-hydrogen` / `gemini-3.1-flash-lite` / `gemini-2.5-flash`）、DeepSeek 开放平台、Groq Cloud（最高 14,400 RPD）、OpenRouter `:free`、GitHub Models、Cerebras、硅基流动，支持客户端直连 SSE 流式与自定义模型列表。
   - 每个模型、数据库、存储桶、历史同步、连接器均配备**真实连接状态灯**。

4. **6 款护眼与工程主题 + 手机/电脑一键切换**
   - 内置 **CF 原生靛蓝（与 cloudflare-ai-web 同款）**、**深海石板**、**极光翠绿**、**暖砂纸墨**、**午夜极客**、**暮色紫罗兰** 6 款主题（均支持浅色/深色）。
   - 顶部一键切换 **手机布局** 与 **电脑布局**，窄屏移动端零文字遮挡。

5. **默认免登录 + 管理员密码分级可见**
   - 普通用户打开即用编程、绘图与文件对话，无强制登录墙。
   - 管理员可使用后台环境变量 `ACCESS_PASSWORD` 或面板内自定义的管理员密码登录；登录后解锁 **仓库连接**、**数据库与文件 (D1 & 存储桶)**、**历史对话与同步**、**连接器中心**、**外接 API 与模型管理区**。

6. **存储桶 (R2/S3) + D1 HTTP API 自动建表 + 连接器**
   - 独立运行时可直接填写 Cloudflare Account ID、D1 UUID、D1 Edit Token，自动执行建表 SQL。
   - 支持 S3/R2 兼容对象存储桶，每条文件明确标注存储位置（`Cloudflare D1` / `存储桶 (R2/S3)` / `本地存储`），支持上传、下载与删除。
   - **连接器中心**支持主流网盘（Alist/阿里云盘/WebDAV/OneDrive/Google Drive）、邮箱（Resend/SMTP）、部署平台（Cloudflare/Vercel/Netlify）等并支持实时探活。

---

## 环境变量说明（`.env.example`）

| 变量名 | 说明 |
| --- | --- |
| `ACCESS_PASSWORD` | 后台预设管理员密码（设置后可直接登录管理区） |
| `TARGET_REPO_URL` | 自定义默认开源目标仓库（默认 `https://github.com/757926525/bcai`） |
| `GEMINI_API_KEY` | Google Gemini 服务端密钥 |
| `CF_ACCOUNT_ID` / `CF_API_TOKEN` | Cloudflare Workers AI 与 D1 HTTP API 凭证 |
| `CF_D1_DATABASE_ID` | Cloudflare D1 数据库 UUID |
| `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | Cloudflare R2 或 S3 兼容存储桶配置 |
| `DEEPSEEK_API_KEY` / `GROQ_API_KEY` / `OPENROUTER_API_KEY` | 可选免费大模型平台环境变量 |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODELS` | 通用 OpenAI 兼容端点与自定义模型 |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `GITHUB_TOKEN` | GitHub OAuth 或 PAT |
| `GITLAB_TOKEN` / `GITEE_TOKEN` | GitLab 与 Gitee 访问令牌 |

---

## 部署指南

### 1. Cloudflare Pages 上传部署（Direct Upload）
1. 点击界面左侧 **部署和使用 -> 下载 Pages 上传包 (.zip)**（或在本地执行 `npm run build` 后将 `dist/` 与打包后的 `_worker.js` 一起上传）。
2. 在 Pages Settings -> Functions 绑定：`AI`（Workers AI）、`DB`（D1）、`BUCKET`（R2，可选）。
3. 使用 `npx wrangler d1 execute bcai-db --remote --file=./schema.sql` 初始化 D1 表结构。

### 2. Cloudflare Pages 拉取部署（Git Pull）
- Framework preset：`Vite` | Build command：`npm run build` | Build output directory：`dist`

### 3. Vercel / Docker / Linux VPS 部署
```bash
git clone https://github.com/757926525/bcai.git
cd bcai
cp .env.example .env
npm ci && npm run build
NODE_ENV=production node server.ts
```
或直接使用 Docker Compose：
```bash
docker compose up -d --build
```

# Personal AI Site

根据《个人网站开发文档-Codex执行版》，当前仓库已经完成前三阶段中的前两阶段与 M3 的核心内容：前后端骨架、账号体系、JWT、RBAC，以及资讯后台 CRUD 和发布链路。

## 当前阶段

- 前端：`Next.js 16 + React 19 + Tailwind CSS 4`
- 后端：`NestJS 11`
- 数据库：优先连接 `PostgreSQL`，缺失时自动回退到 `pg-mem`
- 本地运行：注册、登录、后台权限控制、资讯后台管理已可用

## 目录结构

```text
apps/
  backend/    NestJS API
  frontend/   Next.js site
infra/
  database/
    init/     PostgreSQL 初始化脚本
```

## 本地启动

1. 安装依赖

```bash
npm install
```

2. 复制环境变量模板

```bash
Copy-Item apps/frontend/.env.local.example apps/frontend/.env.local
Copy-Item apps/backend/.env.example apps/backend/.env
```

3. 启动前后端

```bash
npm run dev
```

4. 打开以下地址

- 前端首页: `http://localhost:3100`
- 后端健康检查: `http://localhost:4000/api/health`
- 登录页: `http://localhost:3100/login`
- 资讯后台: `http://localhost:3100/admin/news`

## 默认管理员

如果没有配置额外环境变量，后端启动时会自动初始化默认管理员：

```text
username: admin
password: Admin@123456
```

默认管理员首次登录后会携带 `mustChangePassword=true` 标记，密码修改页面将在后续阶段补齐。
本地调试可以先使用默认密码，但任何可对外访问的环境都应覆盖 `DEFAULT_ADMIN_PASSWORD`。

## 可选：启动 PostgreSQL

当前机器未安装 Docker，但仓库已经准备好 `docker-compose.yml`。安装 Docker Desktop 后可执行：

```bash
npm run db:up
```

数据库连接串默认值：

```text
postgresql://codex:codex_dev_password@localhost:5432/personal_ai_site
```

## 生产 Docker 部署

当前仓库已经补齐了容器化所需的关键文件：

- 前端镜像：`apps/frontend/Dockerfile`
- 后端镜像：`apps/backend/Dockerfile`
- 生产编排：`docker-compose.prod.yml`
- Nginx 反向代理：`infra/nginx/default.conf`
- Python 依赖：`requirements.txt`
- 生产环境变量示例：`.env.production.example`

部署步骤：

1. 复制生产环境变量模板

```bash
cp .env.production.example .env.production
```

2. 按实际域名和密码修改 `.env.production`

- `APP_ORIGIN`
- `POSTGRES_PASSWORD`
- `JWT_SECRET`
- 默认管理员账号信息

3. 构建并启动容器

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

4. 打开服务

- 站点入口：`http://<your-server-ip>:<APP_PORT>`
- Nginx 会把 `/` 转发到前端，把 `/api` 转发到后端

说明：

- 视频处理运行在后端容器内，依赖 `Python + ffmpeg + ffprobe`
- 处理后视频会写入 Docker volume：`video-outputs`
- 上传原视频默认保留 `24` 小时，处理后视频默认保留 `7` 天，后端每 `60` 分钟自动清理一次
- 可通过 `.env.production` 调整：`VIDEO_UPLOAD_RETENTION_HOURS`、`VIDEO_OUTPUT_RETENTION_HOURS`、`VIDEO_CLEANUP_INTERVAL_MINUTES`
- 视频接口默认带 IP 级限流和上传大小熔断，可通过 `.env.production` 调整：`VIDEO_MAX_UPLOAD_BYTES`、`VIDEO_MAX_CHUNK_BYTES`、`VIDEO_RATE_LIMIT_WINDOW_MS`、`VIDEO_RATE_LIMIT_REQUESTS`、`VIDEO_RATE_LIMIT_CHUNK_REQUESTS`、`VIDEO_RATE_LIMIT_OUTPUT_REQUESTS`
- PostgreSQL 数据会写入 Docker volume：`postgres-data`
- 当前 Nginx 配置是 HTTP 版本，HTTPS 证书可在服务器阶段继续补

## 数据库模式

- 如果 `DATABASE_URL` 可连接，应用使用真实 PostgreSQL
- 如果本机没有 PostgreSQL 且 `ALLOW_IN_MEMORY_DB=true`，应用自动回退到 `pg-mem`
- 如果你想强制要求真实 PostgreSQL，把 `ALLOW_IN_MEMORY_DB=false` 写入 `apps/backend/.env`

## 阶段拆分

### Phase 1

- 仓库初始化
- 前台展示骨架
- 后端资讯接口骨架
- PostgreSQL 表结构基线
- 本地启动说明

### Phase 2

- 注册 / 登录 / JWT
- RBAC 权限校验
- 默认管理员初始化
- 后台鉴权和用户列表
- 前端登录态与 `/admin` 保护

### Phase 3

- 资讯后台 CRUD
- 发布 / 下架状态流转
- 前台首页 / 历史页 / 详情页读取真实数据库内容
- 标签关系写入与后台编辑

## 当前已实现

- 公开资讯接口：`/api/news`、`/api/news/today`、`/api/news/:id`
- 后台资讯接口：`/api/admin/news`、`/api/admin/news/:id`
- 后台页面：资讯列表、创建页、编辑页
- 状态流转：草稿、已发布、已下架
- 前台读取：发布后可在首页、历史页和详情页读取

## 下一步

- M4 服务器部署：Nginx、HTTPS、PM2、备份脚本
- M5 二期增强：自动抓取、搜索、标签筛选、审计日志、缓存

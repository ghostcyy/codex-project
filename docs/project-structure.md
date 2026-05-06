# Project Structure

Last reviewed: 2026-05-05

## Top-Level Layout

- `apps/frontend`: Next.js app router frontend, public pages, admin pages, and frontend API proxy routes.
- `apps/backend`: NestJS API, auth/RBAC, news, LLM configuration, video, and HTML-PPT services.
- `infra/database/init`: PostgreSQL initialization and migration SQL.
- `infra/nginx`: production reverse proxy configuration.
- `.agents/skills` and `html-ppt-skill`: HTML-PPT authoring templates and skill assets.
- `.local-runtime`: local generated outputs, logs, browser profiles, and temporary runtime data.

## Frontend Pages

Public pages:

- `/`
- `/today`
- `/news`
- `/news/[id]`
- `/login`
- `/register`
- `/stellar-preview`
- `/tools/video-processing`

Login-required pages:

- `/tools/html-ppt`
- `/tools/html-ppt-v2`
- `/tools/html-ppt-v3`

Admin-only pages:

- `/admin`
- `/admin/news`
- `/admin/news/new`
- `/admin/news/[id]`
- `/admin/llm`

Newer pages and API proxies currently present in the worktree:

- `/tools/html-ppt-v2`
- `/tools/html-ppt-v3`
- `/api/html-ppt-v3/*`
- `/api/ppt/v2/*`

## Backend Modules

- `auth`: login, registration, JWT profile loading, global authentication guard, permission guard, and ADMIN role metadata.
- `admin`: admin overview, user list, and admin news CRUD.
- `llm-config`: site-wide model provider CRUD with encrypted API keys and active-model selection.
- `llm-logging`: model usage and payload logs for admin review.
- `news`: public news list/detail and admin news service support.
- `ppt-chat`: HTML-PPT v1/v2 project and generation services.
- `ppt-chat/html-ppt-v3`: HTML-PPT v3 templates, projects, messages, jobs, SSE, preview, and download endpoints.
- `html-ppt-renderer`: legacy rendered deck access and ownership checks.
- `video`: public video processing routes.

## Access Rules

- Admin routes are locked to the `ADMIN` role. Permissions such as `admin.access`, `news.write`, and `llm.manage` remain useful metadata, but they are not sufficient by themselves to enter the backend or model console.
- Model configuration remains global to the site and is only maintained by admins.
- HTML-PPT v1/v2/v3 tools are available to authenticated users. Projects and generated artifacts are scoped to the owning account.
- Public pages and public news routes do not require a session.

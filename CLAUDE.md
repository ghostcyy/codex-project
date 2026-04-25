# Codex — Project Architecture Manual

> This document is the core reference for the AI assistant to quickly get started with this project. It covers the technology stack, directory structure, module features, database design, environment configuration, and common commands. Prioritize reading this document when receiving a task.

---

## 1. Project Positioning

**Codex** is a personal content and tool workstation (Author: Mipo), which simultaneously hosts:
- Personal brand showcase and news publishing (Today's AI News)
- AI-driven HTML-PPT generation tool
- Video processing tools (transcoding, cropping, padding, rotating, scaling)

---

## 2. Technology Stack Overview

| Layer | Technology |
|------|------|
| **Frontend** | Next.js 16 (App Router), React 19, TailwindCSS 4, TypeScript |
| **Backend** | NestJS 11, TypeScript, Node.js ≥ 20.9 |
| **Database** | PostgreSQL 16 (Production) / pg-mem (Local Development fallback) |
| **ORM** | Raw SQL (pg Pool), no ORM |
| **Auth** | JWT (jsonwebtoken) + bcryptjs password hashing |
| **Video Processing** | ffmpeg-static + ffprobe-static (embedded in npm package, no system installation required) |
| **LLM Integration** | OpenAI-compatible API (via undici fetch, supports streaming heartbeat) |
| **Package Management** | npm workspaces (root `package.json` manages monorepo) |
| **Containerization** | Docker Compose (postgres container for development; `docker-compose.prod.yml` for production) |
| **Reverse Proxy** | Nginx (`infra/nginx/`, production environment) |

---

## 3. Monorepo Directory Structure

```
Codex/
├── apps/
│   ├── backend/          # NestJS API service (Port 4000)
│   │   └── src/
│   │       ├── main.ts              # Entry point: bootstrap NestJS, prefix /api, CORS
│   │       ├── app.module.ts        # Root module, registers all business modules
│   │       ├── common/              # Global utilities
│   │       │   ├── load-env.ts      # Load .env file
│   │       │   └── auth/            # Decorators: @Public, @CurrentUser, @RequirePermissions
│   │       └── modules/
│   │           ├── database/        # DatabaseService (pg Pool / pg-mem dual mode)
│   │           ├── auth/            # Registration/Login/JWT/RBAC
│   │           ├── admin/           # Admin overview, news management API
│   │           ├── news/            # News list, today's news API
│   │           ├── video/           # Video upload, probe, transcoding (ffmpeg)
│   │           ├── llm-config/      # LLM config management (AES-256-GCM encrypted API Key)
│   │           ├── html-ppt-renderer/ # Static Deck file hosting (HTML/CSS/assets/ZIP stream response)
│   │           └── ppt-chat/        # HTML-PPT chat project management + AI orchestration Agent
│   │
│   └── frontend/         # Next.js Frontend (Port 3100)
│       ├── app/
│       │   ├── layout.tsx           # Root layout: ParticlesBg + SiteHeader + SiteFooter
│       │   ├── page.tsx             # Home page
│       │   ├── today/               # Today's news page
│       │   ├── news/                # News list page + detail page [id]
│       │   ├── login/ register/     # Authentication pages
│       │   ├── admin/               # Admin dashboard (LLM config, news management)
│       │   ├── tools/
│       │   │   ├── html-ppt/        # HTML-PPT Studio (Single file large page, ~49KB)
│       │   │   └── video-processing/ # Video processing workbench
│       │   └── api/                 # Next.js Route Handlers (Client video API proxy)
│       ├── components/
│       │   ├── site-header.tsx      # Global navigation bar (includes login status, admin portal)
│       │   ├── site-footer.tsx      # Footer
│       │   ├── particles-bg.tsx     # Background particle animation
│       │   ├── smart-header.tsx     # Adaptive Header switching component
│       │   ├── auth/                # Login/Register form components
│       │   ├── admin/               # Admin dashboard components
│       │   └── tools/               # Video tool components (crop/pad/rotate/scale/workbench)
│       ├── lib/
│       │   ├── api.ts               # Server-side fetch wrapper (with fallback)
│       │   ├── server-auth.ts       # Server-side JWT authentication utilities
│       │   ├── client-video-api.ts  # Client-side video API calls
│       │   ├── video-*.ts           # Video geometry/metadata/transcode/upload session utilities
│       │   ├── types.ts             # Shared type definitions
│       │   └── fallback-data.ts     # Fallback data when API is unavailable
│       └── types/                   # Global TypeScript type extensions
│
├── infra/
│   ├── database/init/               # SQL initialization scripts (executed sequentially)
│   │   ├── 001_base_schema.sql      # Full schema DDL
│   │   ├── 002_seed_rbac.sql        # Predefined roles and permissions
│   │   └── 003_seed_sample_news.sql # Sample news data
│   └── nginx/                       # Nginx configuration (Production)
│
├── scripts/                         # Helper scripts (Python)
│   ├── import_sqlite_ai_news.py     # SQLite news import tool
│   ├── autotag_imported_news.sql    # Auto-tagging SQL
│   ├── generate_geometry_gifs.py    # Geometry animation GIF generation
│   └── transcode_video.py           # Batch video transcoding script
│
├── .agents/skills/html-ppt/         # HTML-PPT Skill package (templates, themes, assets, runtime)
├── docker-compose.yml               # Local development (postgres container only)
├── docker-compose.prod.yml          # Production full-stack deployment
├── package.json                     # Monorepo root (npm workspaces)
└── tsconfig.base.json               # Shared TypeScript base config
```

---

## 4. Backend Modules Details

### 4.1 DatabaseService (`modules/database/`)

- **Dual Mode**: Connects to PostgreSQL when `DATABASE_URL` is present; otherwise gracefully degrades to `pg-mem` (in-memory PostgreSQL compatibility layer), no need to start a database container during development.
- **Auto-execution on Startup**: Reads `infra/database/init/*.sql` to initialize table structures sequentially → presets RBAC → creates default admin account.
- **Default Admin**: `admin / Admin@123456` (Must be overridden by environment variables in production).

### 4.2 AuthModule (`modules/auth/`)

- Registration (`POST /api/auth/register`), Login (`POST /api/auth/login`), Get Profile (`GET /api/auth/me`).
- JWT issuance, default validity is 7 days (configurable via `JWT_EXPIRES_IN`).
- Guard System: `JwtAuthGuard` (Global) + `@Public()` decorator for exemptions + `PermissionsGuard` (Fine-grained permissions).

### 4.3 RBAC Permissions Table

| Role | Permissions |
|------|-------------|
| `ADMIN` | `admin.access`, `news.read/write`, `user.manage`, `role.manage`, `llm.manage` |
| `EDITOR` | `admin.access`, `news.read/write` |
| `USER` | `news.read` |

### 4.4 NewsModule (`modules/news/`)

- `GET /api/news/today` — Today's news aggregate package (articles published in the last 24h)
- `GET /api/news` — Paginated list (supports `page`, `pageSize`, `date` filters)
- `GET /api/news/:id` — Single article detail (id or slug)
- All endpoints are marked with `@Public()`, no authentication required.

### 4.5 VideoModule (`modules/video/`)

Video processing uses **ffmpeg-static** and **ffprobe-static**, requiring no system installation of ffmpeg.

**Single File Mode:**
- `POST /api/video/inspect` — Upload and parse video metadata
- `POST /api/video/transcode` — Upload and transcode

**Chunked Upload Session Mode (Large Files):**
- `POST /api/video/uploads/init` — Create upload session
- `POST /api/video/uploads/:id/chunk` — Upload chunk (default max 8MB per chunk)
- `POST /api/video/uploads/:id/inspect` — Parse video of a completed session
- `POST /api/video/uploads/:id/transcode` — Transcode video of a completed session

**Output Download:**
- `GET /api/video/output/:id` — Stream transcoded result (`?download=1` triggers attachment download)

Supported processing operations (via `geometryConfig` parameter): Scale, Pad, Crop, Rotate.
Rate limiting is implemented by `VideoRateLimitGuard` (in-memory counter).

### 4.6 LlmConfigModule (`modules/llm-config/`)

- Globally unique LLM configuration record (table `llm_provider_settings`, `id=1`).
- API Key is encrypted using AES-256-GCM (`LLM_CONFIG_ENCRYPTION_KEY` environment variable, default is insecure, must be replaced in production).
- Supports OpenAI-compatible protocol (`baseUrl` + `model` + `apiKey`).
- `getActiveConfig()` is the unified entry point for all LLM calls, throws `ServiceUnavailableException` when not enabled.

### 4.7 HtmlPptRendererModule (`modules/html-ppt-renderer/`)

Static Deck file hosting service, path prefix `/api/ppt/decks/:deckId/`:

| Endpoint | Description |
|----------|-------------|
| `index.html` | Full presentation page (references external assets) |
| `preview.html` | Preview page (same as above) |
| `style.css` | Deck-specific styles |
| `asset?path=...` | Any asset file (base.css, themes, runtime.js, etc.) |
| `download.html` | Portable single file (inlines all resources) |
| `download.zip` | ZIP package download |

### 4.8 PptChatModule (`modules/ppt-chat/`)

Core module for HTML-PPT chat and AI orchestration.

**Project Management (Requires Authentication):**
- `GET /api/ppt/projects` — List user's PPT projects
- `POST /api/ppt/projects` — Create new project
- `PATCH /api/ppt/projects/:id` — Update project name/template
- `DELETE /api/ppt/projects/:id` — Delete project
- `GET /api/ppt/projects/:id/messages` — Get chat history
- `POST /api/ppt/projects/:id/messages` — Send message (triggers AI generation)
- `POST /api/ppt/projects/:id/messages/:messageId/resume` — Resume failed generation task

**AI Orchestration (`HtmlPptAgentService`) 8-Step Pipeline:**

```
01 Read skill and template directories
    ↓
02 Topic research compilation (LLM JSON)
    ↓
03 Content planning (LLM JSON) → AgentPlan (Slide outline + layoutId binding)
    ↓
04 Visual planning (LLM JSON) → VisualPlan (Theme, animations, composition)
    ↓
05 Generate index.html (Batch generate sections, includes auto-QA and repair)
    ↓
06 Generate style.css (LLM generated, includes runtime safety guard)
    ↓
07 Copy assets and package for portability (publishStaticDeck)
    ↓
08 Local HTML QA (pages/active/notes/progress-bar/position override)
```

**Critical Design Constraints (To avoid recurring bugs):**
- `style.css` must not contain `.slide { position: relative/static/fixed }`, as it overrides the runtime's `position: absolute` and breaks navigation.
- The `progress-bar` div must be placed immediately inside `<body>` before `<div class="deck">`, otherwise `runtime.js` querySelector will crash.
- Theme CSS variables must be scoped to `html[data-theme="..."]` to prevent multi-theme variable injections from overriding each other.
- HTML-PPT Skill package path is controlled by the `HTML_PPT_SKILL_ROOT` environment variable, defaults to `.agents/skills/html-ppt/`.

---

## 5. Frontend Page Routes

| Route | Description |
|-------|-------------|
| `/` | Home page (Site introduction + three feature portals) |
| `/today` | Today's news aggregate page |
| `/news` | News list (paginated) |
| `/news/[id]` | News detail |
| `/login` | Login page |
| `/register` | Registration page |
| `/admin` | Admin dashboard (requires `admin.access` permission) |
| `/admin/llm` | LLM configuration management |
| `/admin/news` | News content management |
| `/tools/html-ppt` | HTML-PPT Studio (AI chat to generate PPT) |
| `/tools/video-processing` | Video processing workbench |

**Global Layout Components:**
- `ParticlesBg` — Canvas particle background animation
- `SiteHeader` — Navigation bar (includes login state awareness, admin menu)
- `SiteFooter` — Footer

---

## 6. Database Schema

```sql
-- Authentication and Permissions
users               -- User accounts (username, email, password_hash, status, must_change_password)
roles               -- Roles (ADMIN / EDITOR / USER)
permissions         -- Permission points (code like news.read, llm.manage)
user_roles          -- User-Role Many-to-Many
role_permissions    -- Role-Permission Many-to-Many
operation_logs      -- Action audit logs (JSONB detail)

-- News
news_articles       -- Articles (slug, title, summary, content, source, publish_date, status)
news_tags           -- Tags
article_tags        -- Article-Tag Many-to-Many

-- LLM Configuration
llm_provider_settings  -- Single record (id=1), api_key_ciphertext AES-256-GCM encrypted

-- HTML-PPT
ppt_projects        -- User PPT projects (name, template_id, status)
ppt_messages        -- Chat messages (role, content, meta JSONB stores deckSpec/deckRender/orchestration)
ppt_project_summaries  -- Project chat summaries (used for Agent long-context compression)
```

---

## 7. Environment Variables

### Backend (`apps/backend/.env`)

| Variable | Description | Default Value |
|----------|-------------|---------------|
| `DATABASE_URL` | PostgreSQL connection string | None (degrades to pg-mem) |
| `ALLOW_IN_MEMORY_DB` | Allow pg-mem fallback | `true` |
| `JWT_SECRET` | JWT signing secret | `change-this-in-phase-2` |
| `JWT_EXPIRES_IN` | JWT validity period | `7d` |
| `DEFAULT_ADMIN_USERNAME` | Default admin username | `admin` |
| `DEFAULT_ADMIN_PASSWORD` | Default admin password | `Admin@123456` |
| `LLM_CONFIG_ENCRYPTION_KEY` | LLM API Key encryption key | Development default (Must replace in production) |
| `HTML_PPT_SKILL_ROOT` | Absolute path to HTML-PPT Skill pack | Auto-searches `.agents/skills/html-ppt/` |
| `LLM_REQUEST_TIMEOUT_MS` | LLM single request timeout | `600000` (10 minutes) |
| `LLM_TRANSPORT_TIMEOUT_MS` | LLM transport layer timeout | `660000` |
| `PPT_MODEL_TIMEOUT_MS` | PPT Agent model timeout | Same as LLM_REQUEST_TIMEOUT_MS |
| `FRONTEND_ORIGIN` | Frontend CORS origin | `http://localhost:3100` |
| `PORT` | Backend listening port | `4000` |
| `VIDEO_MAX_UPLOAD_BYTES` | Max video upload size | `2147483648` (2GB) |
| `VIDEO_MAX_CHUNK_BYTES` | Max chunk size | `8388608` (8MB) |
| `VIDEO_UPLOAD_RETENTION_HOURS` | Upload file retention time | `24` |
| `VIDEO_OUTPUT_RETENTION_HOURS` | Output file retention time | `168` (7 days) |
| `HTML_PPT_OUTPUT_RETENTION_HOURS` | PPT output file retention time | `168` |

### Frontend (`apps/frontend/.env.local`)

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_API_BASE_URL` | Client-side API base URL |
| `API_BASE_URL` | Server-side rendering API base URL (takes precedence over NEXT_PUBLIC_*) |

---

## 8. Common Development Commands

```bash
# Start both frontend and backend (concurrently)
npm run dev

# Start backend only (Port 4000)
npm run dev --workspace @codex/backend

# Start frontend only (Port 3100)
npm run dev --workspace @codex/frontend

# Start local PostgreSQL container
npm run db:up

# Stop database container
npm run db:down

# Type checking (full)
npm run typecheck

# Build (full)
npm run build

# Production Docker build
npm run docker:prod:build

# Production Docker start
npm run docker:prod:up
```

---

## 9. HTML-PPT Skill Package Structure

Located at `.agents/skills/html-ppt/` (read by Agent at runtime):

```
html-ppt/
├── SKILL.md                  # Skill rules documentation (Agent context prompt)
├── assets/
│   ├── base.css              # Base layout / slide system CSS
│   ├── runtime.js            # Keyboard/touch navigation + progress-bar control
│   ├── edit-mode.js          # Edit mode (optional)
│   ├── themes/               # Theme CSS (e.g., blue-dark.css, white-clean.css)
│   └── animations/           # Animation CSS and fx-runtime.js
├── templates/
│   ├── full-decks/           # Full Deck examples (used as AI references)
│   └── single-page/          # Single page layout templates (Agent references by layoutId)
└── references/
    ├── layouts.md            # Documentation for all layouts
    └── full-decks.md         # Documentation for full deck directories
```

**Important**: `runtime.js` controls the progress bar via `document.querySelector('.progress-bar span')`. This element must exist and be placed before `.deck`, otherwise navigation will fail.

---

## 10. Known Critical Issues & Fix History

| Issue | Root Cause | Fix Strategy |
|-------|------------|--------------|
| Navigation fails after PPT page 1 | `.slide { position: relative }` in `style.css` overrides `position: absolute` from `base.css` | `stripSlidePositionOverride()` + `detectSlidePositionOverride()` QA check in `html-ppt-agent.service.ts` |
| progress-bar querySelector crash | Business CSS generated `.progress-bar` inside `.deck` | `ensureRuntimeProgressBar()` forces progress-bar injection at the beginning of `<body>` |
| Multi-theme CSS variable conflicts | Theme CSS used bare `:root {}` selectors | Scoped theme CSS to `html[data-theme="..."] {}` selectors |
| Empty placeholder nodes cause visual anomalies | AI generated empty `.metric-label`, `.caption` nodes | `stripEmptyLeafPlaceholderNodes()` auto-cleans them |

---

## 11. Project Collaboration Roles

- **Mipo** — Creator & Product Owner, defines direction, feature goals, and content judgment
- **Codex** — Engineering Implementation, handles frontend/backend development, database, deployment
- **Antigravity** — AI Assistant, design research, solution proposals, code implementation

---

*Last Updated: 2026-04-24*

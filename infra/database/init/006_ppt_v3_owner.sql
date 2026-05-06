CREATE TABLE IF NOT EXISTS ppt_v3_projects (
  id UUID PRIMARY KEY,
  user_id UUID NULL,
  owner_user_id BIGINT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  selected_template_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ppt_v3_jobs (
  id UUID PRIMARY KEY,
  user_id UUID NULL,
  owner_user_id BIGINT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID NULL,
  request JSONB NOT NULL,
  template_id TEXT NOT NULL,
  status TEXT NOT NULL,
  output_dir TEXT NULL,
  zip_path TEXT NULL,
  preview_path TEXT NULL,
  plan JSONB NULL,
  content JSONB NULL,
  error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS ppt_v3_messages (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES ppt_v3_projects(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('text', 'clarification', 'job', 'error')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE ppt_v3_projects
ADD COLUMN IF NOT EXISTS owner_user_id BIGINT REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ppt_v3_jobs
ADD COLUMN IF NOT EXISTS owner_user_id BIGINT REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ppt_v3_jobs
ADD COLUMN IF NOT EXISTS project_id UUID NULL;

UPDATE ppt_v3_projects
SET owner_user_id = admin.id
FROM (
  SELECT id
  FROM users
  WHERE LOWER(username) = LOWER('admin')
  LIMIT 1
) admin
WHERE ppt_v3_projects.owner_user_id IS NULL;

UPDATE ppt_v3_jobs
SET owner_user_id = ppt_v3_projects.owner_user_id
FROM ppt_v3_projects
WHERE ppt_v3_jobs.project_id = ppt_v3_projects.id
  AND (
    ppt_v3_jobs.owner_user_id IS NULL
    OR ppt_v3_jobs.owner_user_id <> ppt_v3_projects.owner_user_id
  );

UPDATE ppt_v3_jobs
SET owner_user_id = admin.id
FROM (
  SELECT id
  FROM users
  WHERE LOWER(username) = LOWER('admin')
  LIMIT 1
) admin
WHERE ppt_v3_jobs.owner_user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_ppt_v3_projects_owner_updated ON ppt_v3_projects(owner_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ppt_v3_messages_project_created ON ppt_v3_messages(project_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_ppt_v3_jobs_owner_created ON ppt_v3_jobs(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ppt_v3_jobs_owner_project ON ppt_v3_jobs(owner_user_id, project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ppt_v3_project ON ppt_v3_jobs(project_id, created_at DESC);

INSERT INTO roles (code, name, description)
VALUES
  ('ADMIN', '管理员', '拥有后台完整权限'),
  ('USER', '普通用户', '可浏览资讯与维护个人资料'),
  ('EDITOR', '编辑者', '可维护资讯但不能管理用户和角色')
ON CONFLICT (code) DO NOTHING;

INSERT INTO permissions (code, name, resource, action)
VALUES
  ('admin.access', '进入后台', 'admin', 'access'),
  ('news.read', '浏览资讯', 'news', 'read'),
  ('news.write', '维护资讯', 'news', 'write'),
  ('user.manage', '管理用户', 'users', 'manage'),
  ('role.manage', '管理角色', 'roles', 'manage'),
  ('llm.manage', '管理模型配置', 'llm', 'manage')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON TRUE
WHERE r.code = 'ADMIN'
  AND p.code IN ('admin.access', 'news.read', 'news.write', 'user.manage', 'role.manage', 'llm.manage')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON TRUE
WHERE r.code = 'USER'
  AND p.code IN ('news.read')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON TRUE
WHERE r.code = 'EDITOR'
  AND p.code IN ('admin.access', 'news.read', 'news.write')
ON CONFLICT DO NOTHING;

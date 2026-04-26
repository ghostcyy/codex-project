import type { SessionUser } from "./types";

export const ADMIN_ACCESS_PERMISSION = "admin.access";

type UserWithPermissions = Pick<SessionUser, "permissions"> | null | undefined;

function isAdminPath(path: string) {
  return path === "/admin" || path.startsWith("/admin/") || path.startsWith("/admin?");
}

export function hasPermission(user: UserWithPermissions, permission: string) {
  return Boolean(user?.permissions.includes(permission));
}

export function canAccessPath(user: UserWithPermissions, path: string) {
  if (!isAdminPath(path)) {
    return true;
  }

  return hasPermission(user, ADMIN_ACCESS_PERMISSION);
}

export function normalizeNextPath(nextPath: string | null | undefined, fallback = "/") {
  if (typeof nextPath !== "string") {
    return fallback;
  }

  const value = nextPath.trim();

  if (!value.startsWith("/") || value.startsWith("//")) {
    return fallback;
  }

  return value;
}

export function resolveSignedInPath(user: UserWithPermissions, requestedPath?: string | null) {
  const fallback = hasPermission(user, ADMIN_ACCESS_PERMISSION) ? "/admin" : "/";
  const nextPath = normalizeNextPath(requestedPath, fallback);

  return canAccessPath(user, nextPath) ? nextPath : fallback;
}

import type { SessionUser } from "./types";

export const ADMIN_ACCESS_PERMISSION = "admin.access";
export const ADMIN_ROLE = "ADMIN";

type UserWithPermissions = Pick<SessionUser, "permissions"> | null | undefined;
type UserWithRoles = Pick<SessionUser, "roles"> | null | undefined;
type AuthUser = (Pick<SessionUser, "permissions"> & Pick<SessionUser, "roles">) | null | undefined;

function isAdminPath(path: string) {
  return path === "/admin" || path.startsWith("/admin/") || path.startsWith("/admin?");
}

export function hasPermission(user: UserWithPermissions, permission: string) {
  return Boolean(user?.permissions.includes(permission));
}

export function isAdminUser(user: UserWithRoles) {
  return Boolean(user?.roles.includes(ADMIN_ROLE));
}

export function canAccessPath(user: AuthUser, path: string) {
  if (!isAdminPath(path)) {
    return true;
  }

  return isAdminUser(user);
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

export function resolveSignedInPath(user: AuthUser, requestedPath?: string | null) {
  const fallback = "/";
  const nextPath = normalizeNextPath(requestedPath, fallback);

  return canAccessPath(user, nextPath) ? nextPath : fallback;
}

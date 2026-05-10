import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type {
  AdminNewsArticle,
  AdminOverviewResponse,
  AdminUserSummary,
  ImageModelConfigSummary,
  JsonModelConfigSummary,
  LlmConfigSummary,
  PptMessageDto,
  PptProjectSummary,
  SessionUser
} from "./types";
import { ADMIN_ROLE, isAdminUser } from "./auth";

const API_BASE_URL =
  process.env.API_BASE_URL ??
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  "http://localhost:4000/api";

const SESSION_COOKIE_NAME = "personal_ai_site_session";

export function getSessionCookieName() {
  return SESSION_COOKIE_NAME;
}

export async function getSessionToken() {
  const cookieStore = await cookies();
  return cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null;
}

export async function fetchWithSession(path: string, init: RequestInit = {}) {
  const token = await getSessionToken();

  if (!token) {
    return null;
  }

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);

  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    cache: "no-store",
    headers
  });
}

async function requestAuthenticated<T>(path: string): Promise<T | null> {
  try {
    const response = await fetchWithSession(path);

    if (!response || !response.ok) {
      return null;
    }

    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export async function getCurrentUser() {
  return requestAuthenticated<SessionUser>("/auth/profile");
}

export async function requireUserWithPermission(permission: string, nextPath: string) {
  const user = await getCurrentUser();

  if (!user) {
    redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  }

  if (!user.permissions.includes(permission)) {
    redirect("/");
  }

  return user;
}

export async function requireAdminUser(nextPath = "/admin") {
  const user = await getCurrentUser();

  if (!user) {
    redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  }

  if (!isAdminUser(user) || !user.roles.includes(ADMIN_ROLE)) {
    redirect("/");
  }

  return user;
}

export async function requireLlmManagerUser(nextPath = "/admin/llm") {
  return requireAdminUser(nextPath);
}

export async function requireNewsManagerUser(nextPath = "/admin/news") {
  return requireAdminUser(nextPath);
}

export async function getAdminOverview() {
  return requestAuthenticated<AdminOverviewResponse>("/admin/overview");
}

export async function getAdminUsers() {
  return requestAuthenticated<AdminUserSummary[]>("/admin/users");
}

export async function getAdminLlmConfigs() {
  return requestAuthenticated<LlmConfigSummary[]>("/admin/llm-config");
}

export async function getAdminImageModelConfig() {
  return requestAuthenticated<ImageModelConfigSummary>("/admin/llm-config/image/default");
}

export async function getAdminJsonModelConfig() {
  return requestAuthenticated<JsonModelConfigSummary>("/admin/llm-config/json/default");
}

export async function getAdminLlmLogs() {
  return requestAuthenticated<any>("/admin/llm-logs");
}

export async function getAdminLlmStats() {
  return requestAuthenticated<any>("/admin/llm-logs/stats");
}

export async function getAdminNews(status?: string) {
  const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
  return requestAuthenticated<AdminNewsArticle[]>(`/admin/news${suffix}`);
}

export async function getAdminNewsItem(id: string) {
  return requestAuthenticated<AdminNewsArticle>(`/admin/news/${encodeURIComponent(id)}`);
}

export async function getPptProjects() {
  return requestAuthenticated<PptProjectSummary[]>("/ppt/projects");
}

export async function getPptMessages(id: string) {
  return requestAuthenticated<PptMessageDto[]>(`/ppt/projects/${encodeURIComponent(id)}/messages`);
}

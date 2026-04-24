"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fetchWithSession } from "../../../lib/server-auth";
import type { NewsMutationResponse } from "../../../lib/types";

function normalizeErrorMessage(value: unknown, fallback: string) {
  if (
    value &&
    typeof value === "object" &&
    "message" in value &&
    typeof value.message === "string" &&
    value.message.trim().length > 0
  ) {
    return value.message;
  }

  return fallback;
}

function serializeNewsForm(formData: FormData) {
  return {
    slug: String(formData.get("slug") ?? ""),
    title: String(formData.get("title") ?? ""),
    summary: String(formData.get("summary") ?? ""),
    content: String(formData.get("content") ?? ""),
    sourceName: String(formData.get("sourceName") ?? ""),
    sourceUrl: String(formData.get("sourceUrl") ?? ""),
    publishDate: new Date(String(formData.get("publishDate") ?? "")).toISOString(),
    status: String(formData.get("status") ?? "draft"),
    tags: String(formData.get("tags") ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  };
}

async function forwardJson(path: string, init: RequestInit) {
  const response = await fetchWithSession(path, {
    ...init,
    body:
      typeof init.body === "string" || init.body === undefined
        ? init.body
        : JSON.stringify(init.body)
  });

  if (!response) {
    return {
      ok: false,
      status: 401,
      payload: { message: "登录态失效，请重新登录。" }
    };
  }

  return {
    ok: response.ok,
    status: response.status,
    payload: (await response.json().catch(() => null)) as unknown
  };
}

function revalidateNewsPaths(articleId?: string) {
  revalidatePath("/");
  revalidatePath("/news");
  revalidatePath("/admin");
  revalidatePath("/admin/news");

  if (articleId) {
    revalidatePath(`/news/${articleId}`);
    revalidatePath(`/admin/news/${articleId}`);
  }
}

export async function createNewsArticleAction(formData: FormData) {
  const result = await forwardJson("/admin/news", {
    method: "POST",
    body: JSON.stringify(serializeNewsForm(formData))
  });

  if (!result.ok || !result.payload || typeof result.payload !== "object" || !("article" in result.payload)) {
    const message = normalizeErrorMessage(result.payload, "创建资讯失败。");
    redirect(`/admin/news/new?error=${encodeURIComponent(message)}`);
  }

  const payload = result.payload as NewsMutationResponse;
  revalidateNewsPaths(payload.article.id);
  redirect(`/admin/news/${payload.article.id}?saved=1`);
}

export async function updateNewsArticleAction(id: string, formData: FormData) {
  const result = await forwardJson(`/admin/news/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(serializeNewsForm(formData))
  });

  if (!result.ok || !result.payload || typeof result.payload !== "object" || !("article" in result.payload)) {
    const message = normalizeErrorMessage(result.payload, "更新资讯失败。");
    redirect(`/admin/news/${encodeURIComponent(id)}?error=${encodeURIComponent(message)}`);
  }

  const payload = result.payload as NewsMutationResponse;
  revalidateNewsPaths(payload.article.id);
  redirect(`/admin/news/${payload.article.id}?saved=1`);
}

export async function setNewsStatusAction(id: string, status: string, redirectPath: string) {
  const result = await forwardJson(`/admin/news/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ status })
  });

  if (!result.ok) {
    const message = normalizeErrorMessage(result.payload, "更新状态失败。");
    redirect(`${redirectPath}?error=${encodeURIComponent(message)}`);
  }

  revalidateNewsPaths(id);
  redirect(redirectPath);
}

export async function deleteNewsArticleAction(id: string, redirectPath: string) {
  const result = await forwardJson(`/admin/news/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });

  if (!result.ok) {
    const message = normalizeErrorMessage(result.payload, "删除资讯失败。");
    redirect(`${redirectPath}?error=${encodeURIComponent(message)}`);
  }

  revalidateNewsPaths(id);
  redirect("/admin/news");
}


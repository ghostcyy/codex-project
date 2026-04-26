"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fetchWithSession, requireLlmManagerUser } from "../../../lib/server-auth";

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

export async function createLlmConfigAction(formData: FormData) {
  await requireLlmManagerUser("/admin/llm");
  const payload = {
    name: String(formData.get("name") ?? "New Model"),
    providerType: String(formData.get("providerType") ?? "openai-compatible"),
    baseUrl: String(formData.get("baseUrl") ?? ""),
    apiKey: String(formData.get("apiKey") ?? ""),
    model: String(formData.get("model") ?? ""),
    enabled: String(formData.get("enabled") ?? "") === "on"
  };

  const response = await fetchWithSession("/admin/llm-config", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  if (!response) redirect("/admin/llm?error=" + encodeURIComponent("登录态失效，请重新登录。"));
  const result = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) redirect(`/admin/llm?error=${encodeURIComponent(normalizeErrorMessage(result, "创建模型配置失败。"))}`);

  revalidatePath("/admin");
  revalidatePath("/admin/llm");
  redirect("/admin/llm?saved=1");
}

export async function updateLlmConfigAction(formData: FormData) {
  await requireLlmManagerUser("/admin/llm");
  const id = String(formData.get("id"));
  const payload = {
    name: String(formData.get("name") ?? "New Model"),
    providerType: String(formData.get("providerType") ?? "openai-compatible"),
    baseUrl: String(formData.get("baseUrl") ?? ""),
    apiKey: String(formData.get("apiKey") ?? ""),
    model: String(formData.get("model") ?? ""),
    enabled: String(formData.get("enabled") ?? "") === "on"
  };

  const response = await fetchWithSession(`/admin/llm-config/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  });

  if (!response) redirect("/admin/llm?error=" + encodeURIComponent("登录态失效，请重新登录。"));
  const result = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) redirect(`/admin/llm?error=${encodeURIComponent(normalizeErrorMessage(result, "保存模型配置失败。"))}`);

  revalidatePath("/admin");
  revalidatePath("/admin/llm");
  redirect("/admin/llm?saved=1");
}

export async function deleteLlmConfigAction(formData: FormData) {
  await requireLlmManagerUser("/admin/llm");
  const id = String(formData.get("id"));
  
  const response = await fetchWithSession(`/admin/llm-config/${id}`, {
    method: "DELETE"
  });

  if (!response) redirect("/admin/llm?error=" + encodeURIComponent("登录态失效，请重新登录。"));
  const result = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) redirect(`/admin/llm?error=${encodeURIComponent(normalizeErrorMessage(result, "删除模型配置失败。"))}`);

  revalidatePath("/admin");
  revalidatePath("/admin/llm");
  redirect("/admin/llm?saved=1");
}

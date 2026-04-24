import {
  createFallbackAdminOverview,
  createFallbackHealth,
  createFallbackNewsList,
  createFallbackTodayResponse
} from "./fallback-data";
import type {
  AdminOverviewResponse,
  HealthResponse,
  NewsArticle,
  NewsListResponse,
  TodayNewsResponse
} from "./types";

const API_BASE_URL =
  process.env.API_BASE_URL ??
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  "http://localhost:4000/api";

async function request<T>(path: string, fallback: T): Promise<T> {
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }

    return (await response.json()) as T;
  } catch {
    return fallback;
  }
}

export function getHealth() {
  return request<HealthResponse>("/health", createFallbackHealth());
}

export function getTodayNews() {
  return request<TodayNewsResponse>("/news/today", createFallbackTodayResponse());
}

export function getNewsList(date?: string, pageSize?: number) {
  const searchParams = new URLSearchParams();

  if (typeof date === "string" && date.length > 0) {
    searchParams.set("date", date);
  }

  if (typeof pageSize === "number" && Number.isFinite(pageSize) && pageSize > 0) {
    searchParams.set("pageSize", String(pageSize));
  }

  const query = searchParams.size > 0 ? `?${searchParams.toString()}` : "";

  return request<NewsListResponse>(`/news${query}`, createFallbackNewsList(date));
}

export async function getNewsArticle(id: string): Promise<NewsArticle | null> {
  const response = await request<NewsArticle | null>(
    `/news/${id}`,
    createFallbackNewsList().items.find((item) => item.id === id) ?? null
  );

  return response;
}

export function getAdminOverview() {
  return request<AdminOverviewResponse>("/admin/overview", createFallbackAdminOverview());
}

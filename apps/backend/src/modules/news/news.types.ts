export interface NewsArticle {
  id: string;
  title: string;
  summary: string;
  content: string;
  sourceName: string;
  sourceUrl: string;
  publishDate: string;
  status: "draft" | "published" | "archived";
  tags: readonly string[];
}

export interface AdminNewsArticle extends NewsArticle {
  createdAt: string;
  updatedAt: string;
  collectedAt: string;
  createdBy: number | null;
}

export interface NewsWritePayload {
  slug?: string;
  title?: string;
  summary?: string;
  content?: string;
  sourceName?: string;
  sourceUrl?: string;
  publishDate?: string;
  status?: "draft" | "published" | "archived";
  tags?: string[];
}

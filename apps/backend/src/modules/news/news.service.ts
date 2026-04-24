import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { QueryResultRow } from "pg";
import { DatabaseService } from "../database/database.service";
import type { AdminNewsArticle, NewsArticle, NewsWritePayload } from "./news.types";

interface ArticleRow extends QueryResultRow {
  article_id: number;
  slug: string;
  title: string;
  summary: string;
  content: string;
  source_name: string;
  source_url: string;
  publish_date: Date | string;
  collected_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
  created_by: number | null;
  status: "draft" | "published" | "archived";
  tags: string[] | null;
}

interface CountRow extends QueryResultRow {
  total: string;
}

interface StatusCountRow extends QueryResultRow {
  published_count: string;
  draft_count: string;
}

interface ArticleIdRow extends QueryResultRow {
  id: number;
}

interface TagIdRow extends QueryResultRow {
  id: number;
}

type NormalizedWritePayload = {
  slug: string;
  title: string;
  summary: string;
  content: string;
  sourceName: string;
  sourceUrl: string;
  publishDate: string;
  status: "draft" | "published" | "archived";
  tags: string[];
};

const ARTICLE_SELECT = `
  SELECT
    a.id AS article_id,
    a.slug,
    a.title,
    a.summary,
    a.content,
    a.source_name,
    a.source_url,
    a.publish_date,
    a.collected_at,
    a.created_at,
    a.updated_at,
    a.created_by,
    a.status,
    COALESCE(ARRAY_AGG(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL), '{}') AS tags
  FROM news_articles a
  LEFT JOIN article_tags at ON at.article_id = a.id
  LEFT JOIN news_tags t ON t.id = at.tag_id
`;

const ARTICLE_GROUP_BY = `
  GROUP BY
    a.id,
    a.slug,
    a.title,
    a.summary,
    a.content,
    a.source_name,
    a.source_url,
    a.publish_date,
    a.collected_at,
    a.created_at,
    a.updated_at,
    a.created_by,
    a.status
`;

@Injectable()
export class NewsService {
  constructor(@Inject(DatabaseService) private readonly databaseService: DatabaseService) {}

  async getTodayBundle() {
    const todayArticles = await this.listPublishedByDate(new Date());
    const articles = todayArticles.length > 0 ? todayArticles : await this.listPublished(1, 3);
    const spotlight = articles[0];

    if (!spotlight) {
      throw new NotFoundException("No published news articles are available.");
    }

    return {
      generatedAt: new Date().toISOString(),
      spotlight,
      articles
    };
  }

  async list(page = 1, pageSize = 10, date?: string) {
    const safePage = Number.isNaN(page) ? 1 : Math.max(page, 1);
    const safePageSize = Number.isNaN(pageSize) ? 10 : Math.max(pageSize, 1);
    const offset = (safePage - 1) * safePageSize;
    const normalizedDate = this.normalizeDateFilter(date);
    const values: unknown[] = [];
    const filters = ["a.status = 'published'"];

    if (normalizedDate) {
      values.push(normalizedDate);
      filters.push(`a.publish_date::date = $${values.length}::date`);
    }

    values.push(safePageSize, offset);
    const limitPlaceholder = `$${values.length - 1}`;
    const offsetPlaceholder = `$${values.length}`;
    const whereClause = `WHERE ${filters.join(" AND ")}`;

    const rows = await this.queryArticleRows(
      `
        ${ARTICLE_SELECT}
        ${whereClause}
        ${ARTICLE_GROUP_BY}
        ORDER BY a.publish_date DESC
        LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}
      `,
      values
    );
    const totalValues: unknown[] = [];
    const totalFilters = ["status = 'published'"];

    if (normalizedDate) {
      totalValues.push(normalizedDate);
      totalFilters.push(`publish_date::date = $${totalValues.length}::date`);
    }

    const totalResult = await this.databaseService.query<CountRow>(
      `SELECT COUNT(*)::text AS total FROM news_articles WHERE ${totalFilters.join(" AND ")}`,
      totalValues
    );

    return {
      page: safePage,
      pageSize: safePageSize,
      total: Number(totalResult.rows[0]?.total ?? "0"),
      items: rows.map((row) => this.mapPublicArticle(row))
    };
  }

  async getById(id: string) {
    const article = await this.getArticleRowBySlug(id, false);
    return article ? this.mapPublicArticle(article) : null;
  }

  async listAdmin(status?: string) {
    const values: unknown[] = [];
    const filters: string[] = [];

    if (status && ["draft", "published", "archived"].includes(status)) {
      values.push(status);
      filters.push(`a.status = $${values.length}`);
    }

    const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = await this.queryArticleRows(
      `
        ${ARTICLE_SELECT}
        ${whereClause}
        ${ARTICLE_GROUP_BY}
        ORDER BY a.publish_date DESC, a.updated_at DESC
      `,
      values
    );

    return rows.map((row) => this.mapAdminArticle(row));
  }

  async getAdminById(id: string) {
    const article = await this.getArticleRowBySlug(id, true);
    return article ? this.mapAdminArticle(article) : null;
  }

  async createAdminArticle(input: Record<string, unknown>, actorId: number) {
    const payload = this.normalizeWritePayload(input);
    await this.ensureSlugAvailable(payload.slug);

    const result = await this.databaseService.query<ArticleIdRow>(
      `
        INSERT INTO news_articles (
          slug,
          title,
          summary,
          content,
          source_name,
          source_url,
          publish_date,
          status,
          created_by,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9, NOW())
        RETURNING id
      `,
      [
        payload.slug,
        payload.title,
        payload.summary,
        payload.content,
        payload.sourceName,
        payload.sourceUrl,
        payload.publishDate,
        payload.status,
        actorId
      ]
    );
    const articleId = result.rows[0]?.id;

    if (!articleId) {
      throw new BadRequestException("Failed to create article.");
    }

    await this.syncTags(articleId, payload.tags);
    await this.writeOperationLog(actorId, "news.create", payload.slug, {
      title: payload.title,
      status: payload.status
    });

    const article = await this.getAdminById(payload.slug);

    if (!article) {
      throw new NotFoundException("Created article could not be loaded.");
    }

    return { article };
  }

  async updateAdminArticle(id: string, input: Record<string, unknown>, actorId: number) {
    const existing = await this.getArticleRowBySlug(id, true);

    if (!existing) {
      throw new NotFoundException(`News article ${id} was not found.`);
    }

    const payload = this.normalizeWritePayload(input, existing);

    if (payload.slug !== existing.slug) {
      await this.ensureSlugAvailable(payload.slug, existing.article_id);
    }

    await this.databaseService.query(
      `
        UPDATE news_articles
        SET
          slug = $2,
          title = $3,
          summary = $4,
          content = $5,
          source_name = $6,
          source_url = $7,
          publish_date = $8::timestamptz,
          status = $9,
          updated_at = NOW()
        WHERE id = $1
      `,
      [
        existing.article_id,
        payload.slug,
        payload.title,
        payload.summary,
        payload.content,
        payload.sourceName,
        payload.sourceUrl,
        payload.publishDate,
        payload.status
      ]
    );

    await this.syncTags(existing.article_id, payload.tags);
    await this.writeOperationLog(actorId, "news.update", payload.slug, {
      previousSlug: existing.slug,
      status: payload.status
    });

    const article = await this.getAdminById(payload.slug);

    if (!article) {
      throw new NotFoundException("Updated article could not be loaded.");
    }

    return { article };
  }

  async deleteAdminArticle(id: string, actorId: number) {
    const existing = await this.getArticleRowBySlug(id, true);

    if (!existing) {
      throw new NotFoundException(`News article ${id} was not found.`);
    }

    await this.databaseService.query("DELETE FROM news_articles WHERE id = $1", [existing.article_id]);
    await this.writeOperationLog(actorId, "news.delete", existing.slug, {
      title: existing.title
    });

    return { success: true };
  }

  async getAdminOverview() {
    const totalResult = await this.databaseService.query<CountRow>(
      "SELECT COUNT(*)::text AS total FROM news_articles"
    );
    const statusResult = await this.databaseService.query<StatusCountRow>(
      `
        SELECT
          COUNT(*) FILTER (WHERE status = 'published')::text AS published_count,
          COUNT(*) FILTER (WHERE status = 'draft')::text AS draft_count
        FROM news_articles
      `
    );

    return {
      totalArticles: Number(totalResult.rows[0]?.total ?? "0"),
      publishedArticles: Number(statusResult.rows[0]?.published_count ?? "0"),
      draftArticles: Number(statusResult.rows[0]?.draft_count ?? "0"),
      plannedModules: ["密码修改", "用户启用/禁用", "资讯编辑器", "操作日志审计"],
      pendingMilestones: ["M3 资讯后台", "M4 服务器部署", "M5 自动抓取与检索"]
    };
  }

  private async listPublished(page = 1, pageSize = 3) {
    const result = await this.list(page, pageSize);
    return result.items;
  }

  private async listPublishedByDate(date: Date) {
    const isoDate = date.toISOString().slice(0, 10);
    const rows = await this.queryArticleRows(
      `
        ${ARTICLE_SELECT}
        WHERE a.status = 'published' AND a.publish_date::date = $1::date
        ${ARTICLE_GROUP_BY}
        ORDER BY a.publish_date DESC
      `,
      [isoDate]
    );

    return rows.map((row) => this.mapPublicArticle(row));
  }

  private async queryArticleRows(query: string, values: unknown[] = []) {
    const result = await this.databaseService.query<ArticleRow>(query, values);
    return result.rows;
  }

  private async getArticleRowBySlug(slug: string, includeUnpublished: boolean) {
    const values: unknown[] = [slug];
    const statusFilter = includeUnpublished ? "" : "AND a.status = 'published'";
    const rows = await this.queryArticleRows(
      `
        ${ARTICLE_SELECT}
        WHERE a.slug = $1
        ${statusFilter}
        ${ARTICLE_GROUP_BY}
      `,
      values
    );

    return rows[0] ?? null;
  }

  private mapPublicArticle(row: ArticleRow): NewsArticle {
    return {
      id: row.slug,
      title: row.title,
      summary: row.summary,
      content: row.content,
      sourceName: row.source_name,
      sourceUrl: row.source_url,
      publishDate: new Date(row.publish_date).toISOString(),
      status: row.status,
      tags: row.tags ?? []
    };
  }

  private mapAdminArticle(row: ArticleRow): AdminNewsArticle {
    return {
      ...this.mapPublicArticle(row),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      collectedAt: new Date(row.collected_at).toISOString(),
      createdBy: row.created_by
    };
  }

  private normalizeWritePayload(
    input: Record<string, unknown>,
    existing?: ArticleRow
  ): NormalizedWritePayload {
    const fallbackTitle = existing?.title;
    const title = this.readRequiredString(input.title, "title", fallbackTitle);
    const slug = this.normalizeSlug(
      this.readOptionalString(input.slug) ??
        existing?.slug ??
        this.generateSlugFromTitle(title)
    );
    const summary = this.readRequiredString(input.summary, "summary", existing?.summary);
    const content = this.readRequiredString(input.content, "content", existing?.content);
    const sourceName = this.readRequiredString(
      input.sourceName,
      "sourceName",
      existing?.source_name
    );
    const sourceUrl = this.normalizeUrl(
      this.readRequiredString(input.sourceUrl, "sourceUrl", existing?.source_url)
    );
    const publishDate = this.normalizeDate(
      this.readOptionalString(input.publishDate) ??
        (existing ? new Date(existing.publish_date).toISOString() : new Date().toISOString())
    );
    const status = this.normalizeStatus(
      input.status,
      existing?.status ?? "draft"
    );
    const tags = this.normalizeTags(input.tags, existing?.tags ?? []);

    return {
      slug,
      title,
      summary,
      content,
      sourceName,
      sourceUrl,
      publishDate,
      status,
      tags
    };
  }

  private readRequiredString(input: unknown, field: string, fallback?: string) {
    if (typeof input === "string" && input.trim().length > 0) {
      return input.trim();
    }

    if (fallback && fallback.trim().length > 0) {
      return fallback.trim();
    }

    throw new BadRequestException(`${field} is required.`);
  }

  private readOptionalString(input: unknown) {
    if (typeof input !== "string") {
      return null;
    }

    const value = input.trim();
    return value.length > 0 ? value : null;
  }

  private normalizeSlug(value: string) {
    const normalized = value
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, "-")
      .replace(/[^a-z0-9-\u4e00-\u9fa5]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");

    if (!normalized) {
      throw new BadRequestException("slug is required.");
    }

    if (normalized.length > 128) {
      throw new BadRequestException("slug must be 128 characters or fewer.");
    }

    return normalized;
  }

  private generateSlugFromTitle(title: string) {
    const asciiSlug = title
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");

    if (asciiSlug.length > 0) {
      return asciiSlug;
    }

    return `news-${Date.now()}`;
  }

  private normalizeUrl(value: string) {
    try {
      const parsed = new URL(value);
      return parsed.toString();
    } catch {
      throw new BadRequestException("sourceUrl must be a valid URL.");
    }
  }

  private normalizeDate(value: string) {
    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException("publishDate must be a valid date.");
    }

    return date.toISOString();
  }

  private normalizeDateFilter(value?: string) {
    if (!value || value.trim().length === 0) {
      return null;
    }

    const normalized = value.trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
      throw new BadRequestException("date must use YYYY-MM-DD format.");
    }

    const date = new Date(`${normalized}T00:00:00.000Z`);

    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException("date must be a valid calendar day.");
    }

    return normalized;
  }

  private normalizeStatus(
    value: unknown,
    fallback: "draft" | "published" | "archived"
  ) {
    if (typeof value !== "string" || value.trim().length === 0) {
      return fallback;
    }

    if (value === "draft" || value === "published" || value === "archived") {
      return value;
    }

    throw new BadRequestException("status must be draft, published, or archived.");
  }

  private normalizeTags(input: unknown, fallback: readonly string[]) {
    const values = Array.isArray(input)
      ? input
      : typeof input === "string"
        ? input.split(",")
        : [...fallback];

    const normalized = values
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter((value) => value.length > 0);

    return [...new Set(normalized)];
  }

  private async ensureSlugAvailable(slug: string, currentArticleId?: number) {
    const result = await this.databaseService.query<ArticleIdRow>(
      "SELECT id FROM news_articles WHERE slug = $1 LIMIT 1",
      [slug]
    );
    const existingId = result.rows[0]?.id;

    if (existingId && existingId !== currentArticleId) {
      throw new BadRequestException("slug already exists.");
    }
  }

  private async syncTags(articleId: number, tags: string[]) {
    await this.databaseService.query("DELETE FROM article_tags WHERE article_id = $1", [articleId]);

    for (const tagName of tags) {
      const slug = this.normalizeTagSlug(tagName);
      const tagResult = await this.databaseService.query<TagIdRow>(
        `
          INSERT INTO news_tags (name, slug)
          VALUES ($1, $2)
          ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
          RETURNING id
        `,
        [tagName, slug]
      );
      const tagId = tagResult.rows[0]?.id;

      if (!tagId) {
        continue;
      }

      await this.databaseService.query(
        "INSERT INTO article_tags (article_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [articleId, tagId]
      );
    }
  }

  private normalizeTagSlug(tagName: string) {
    const normalized = tagName
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");

    return normalized.length > 0 ? normalized : `tag-${Date.now()}`;
  }

  private async writeOperationLog(
    userId: number,
    action: string,
    targetId: string,
    detail: Record<string, unknown>
  ) {
    await this.databaseService.query(
      `
        INSERT INTO operation_logs (user_id, action, target_type, target_id, detail)
        VALUES ($1, $2, 'news_articles', $3, $4::jsonb)
      `,
      [userId, action, targetId, JSON.stringify(detail)]
    );
  }
}

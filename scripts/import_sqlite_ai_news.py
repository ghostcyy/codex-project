from __future__ import annotations

import argparse
import datetime as dt
import os
import re
import sqlite3
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse


DEFAULT_SQLITE_PATH = Path(r"C:\Users\YuanYuan\Person\Software\Codex\.local-runtime\mipowebsite.db")
DEFAULT_POSTGRES_URL = "postgresql://codex:codex_dev_password@localhost:5432/personal_ai_site"
DEFAULT_PSQL_PATH = Path(r"C:\Program Files\PostgreSQL\16\bin\psql.exe")
OUTPUT_SQL_PATH = Path(r"C:\Users\YuanYuan\Person\Software\Codex\.local-runtime\import_sqlite_ai_news.sql")


REPORT_MARKERS = [
    "成功源",
    "失败源",
    "生成文件",
    "Scraping Agent",
    "下次爬取",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Import curated ai_news records from SQLite into PostgreSQL.")
    parser.add_argument("--sqlite-path", default=str(DEFAULT_SQLITE_PATH))
    parser.add_argument("--postgres-url", default=DEFAULT_POSTGRES_URL)
    parser.add_argument("--psql-path", default=str(DEFAULT_PSQL_PATH))
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def looks_like_report(title: str, summary: str) -> bool:
    normalized_title = (title or "").strip()
    normalized_summary = (summary or "").strip()

    if not normalized_title:
      return True

    if normalized_title.startswith("###"):
        return True

    return any(marker in normalized_summary for marker in REPORT_MARKERS)


def normalize_title(value: str) -> str:
    title = re.sub(r"^[\s#:\-\u20e3\uFE0F0-9️⃣⃣]+", "", (value or "").strip())
    return title.strip() or (value or "").strip()


def normalize_slug(title: str, row_id: int) -> str:
    normalized = re.sub(r"[\s_]+", "-", title.strip().lower())
    normalized = re.sub(r"[^a-z0-9\-\u4e00-\u9fa5]", "", normalized)
    normalized = re.sub(r"-+", "-", normalized).strip("-")
    if not normalized:
        normalized = f"sqlite-ai-news-{row_id}"

    prefix = f"sqlite-ai-news-{row_id}-"
    max_title_part = 128 - len(prefix)
    return f"{prefix}{normalized[:max_title_part].strip('-')}".strip("-")


def normalize_source_name(source: str | None, url: str) -> str:
    if source and source.strip() and not source.strip().lower().startswith(("http://", "https://")):
        return source.strip()[:255]

    host = urlparse(url).netloc.lower()
    host = host.removeprefix("www.")
    return host[:255] or "Imported SQLite Source"


def normalize_datetime(value: str | None, fallback: str | None = None) -> str:
    candidate = (value or fallback or "").strip()
    if not candidate:
        return dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat()

    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", candidate):
        return f"{candidate}T08:00:00+08:00"

    try:
        parsed = dt.datetime.fromisoformat(candidate.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.timezone(dt.timedelta(hours=8)))
        return parsed.isoformat()
    except ValueError:
        return dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat()


def sql_literal(value: str | None) -> str:
    if value is None:
        return "NULL"
    return "'" + value.replace("'", "''") + "'"


def fetch_rows(sqlite_path: Path) -> tuple[list[dict[str, str | int | None]], dict[str, int]]:
    conn = sqlite3.connect(sqlite_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """
        SELECT id, title, source, url, summary, content, published_at, crawled_at
        FROM ai_news
        ORDER BY id ASC
        """
    ).fetchall()
    conn.close()

    stats = {
        "total_rows": len(rows),
        "skipped_report_like": 0,
        "skipped_missing_url": 0,
        "skipped_invalid_url": 0,
        "selected_rows": 0,
    }

    selected: list[dict[str, str | int | None]] = []

    for row in rows:
        title = (row["title"] or "").strip()
        summary = (row["summary"] or "").strip()
        url = (row["url"] or "").strip()

        if not url:
            stats["skipped_missing_url"] += 1
            continue

        if not url.lower().startswith(("http://", "https://")):
            stats["skipped_invalid_url"] += 1
            continue

        if looks_like_report(title, summary):
            stats["skipped_report_like"] += 1
            continue

        cleaned_title = normalize_title(title)
        cleaned_summary = summary or cleaned_title
        cleaned_content = (row["content"] or "").strip() or cleaned_summary

        selected.append(
            {
                "id": row["id"],
                "slug": normalize_slug(cleaned_title, int(row["id"])),
                "title": cleaned_title[:255],
                "summary": cleaned_summary,
                "content": cleaned_content,
                "source_name": normalize_source_name(row["source"], url),
                "source_url": url,
                "publish_date": normalize_datetime(row["published_at"], row["crawled_at"]),
                "collected_at": normalize_datetime(row["crawled_at"], row["published_at"]),
            }
        )

    stats["selected_rows"] = len(selected)
    return selected, stats


def build_sql(rows: list[dict[str, str | int | None]]) -> str:
    statements = [
        "BEGIN;",
        "-- Imported from remote SQLite ai_news table.",
    ]

    for row in rows:
        statements.append(
            f"""
INSERT INTO news_articles (
  slug,
  title,
  summary,
  content,
  source_name,
  source_url,
  publish_date,
  collected_at,
  status,
  created_by,
  created_at,
  updated_at
)
VALUES (
  {sql_literal(str(row["slug"]))},
  {sql_literal(str(row["title"]))},
  {sql_literal(str(row["summary"]))},
  {sql_literal(str(row["content"]))},
  {sql_literal(str(row["source_name"]))},
  {sql_literal(str(row["source_url"]))},
  {sql_literal(str(row["publish_date"]))}::timestamptz,
  {sql_literal(str(row["collected_at"]))}::timestamptz,
  'published',
  NULL,
  NOW(),
  NOW()
)
ON CONFLICT (slug) DO UPDATE
SET
  title = EXCLUDED.title,
  summary = EXCLUDED.summary,
  content = EXCLUDED.content,
  source_name = EXCLUDED.source_name,
  source_url = EXCLUDED.source_url,
  publish_date = EXCLUDED.publish_date,
  collected_at = EXCLUDED.collected_at,
  status = EXCLUDED.status,
  updated_at = NOW();
""".strip()
        )

    statements.append("COMMIT;")
    return "\n\n".join(statements) + "\n"


def run_psql(psql_path: Path, postgres_url: str, sql_path: Path) -> None:
    result = subprocess.run(
        [str(psql_path), "-d", postgres_url, "-v", "ON_ERROR_STOP=1", "-f", str(sql_path)],
        capture_output=True,
        text=True,
        check=False,
    )
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    if result.returncode != 0:
        raise SystemExit(result.returncode)


def main() -> None:
    args = parse_args()
    sqlite_path = Path(args.sqlite_path)
    psql_path = Path(args.psql_path)

    if not sqlite_path.exists():
        raise SystemExit(f"SQLite file not found: {sqlite_path}")

    if not psql_path.exists():
        raise SystemExit(f"psql not found: {psql_path}")

    rows, stats = fetch_rows(sqlite_path)
    sql = build_sql(rows)
    OUTPUT_SQL_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_SQL_PATH.write_text(sql, encoding="utf-8")

    print(f"sqlite_path={sqlite_path}")
    print(f"output_sql={OUTPUT_SQL_PATH}")
    for key, value in stats.items():
        print(f"{key}={value}")

    if args.dry_run:
        return

    run_psql(psql_path, args.postgres_url, OUTPUT_SQL_PATH)


if __name__ == "__main__":
    main()

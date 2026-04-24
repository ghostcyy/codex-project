BEGIN;

WITH rules(tag_name, tag_slug) AS (
  VALUES
    ('TechCrunch', 'techcrunch'),
    ('VentureBeat', 'venturebeat'),
    ('Ars Technica', 'ars-technica'),
    ('Anthropic', 'anthropic'),
    ('GitHub', 'github'),
    ('arXiv', 'arxiv'),
    ('IEEE Spectrum', 'ieee-spectrum'),
    ('MIT Technology Review', 'mit-technology-review'),
    ('Hacker News', 'hacker-news'),
    ('AI News', 'ai-news'),
    ('Stanford', 'stanford'),
    ('Microsoft', 'microsoft'),
    ('BBC', 'bbc'),
    ('OpenAI', 'openai'),
    ('Google', 'google'),
    ('xAI', 'xai'),
    ('Developer Tools', 'developer-tools'),
    ('AI Agents', 'ai-agents'),
    ('Infrastructure', 'infrastructure'),
    ('Funding', 'funding'),
    ('Security', 'security'),
    ('Research', 'research'),
    ('Policy', 'policy'),
    ('Semiconductors', 'semiconductors'),
    ('Robotics', 'robotics'),
    ('Education', 'education'),
    ('Finance', 'finance'),
    ('Math', 'math'),
    ('Social Media', 'social-media'),
    ('Enterprise', 'enterprise')
)
INSERT INTO news_tags (name, slug)
SELECT DISTINCT tag_name, tag_slug
FROM rules
ON CONFLICT (slug) DO UPDATE
SET name = EXCLUDED.name;

WITH imported AS (
  SELECT
    id,
    lower(
      concat_ws(
        ' ',
        coalesce(title, ''),
        coalesce(summary, ''),
        coalesce(source_name, ''),
        coalesce(source_url, '')
      )
    ) AS haystack
  FROM news_articles
  WHERE slug LIKE 'sqlite-ai-news-%'
),
rules(tag_slug, pattern) AS (
  VALUES
    ('techcrunch', 'techcrunch'),
    ('venturebeat', 'venturebeat'),
    ('ars-technica', 'arstechnica'),
    ('anthropic', 'anthropic'),
    ('github', 'github.blog'),
    ('github', 'github'),
    ('arxiv', 'arxiv'),
    ('ieee-spectrum', 'ieee spectrum'),
    ('ieee-spectrum', 'spectrum.ieee'),
    ('mit-technology-review', 'technologyreview'),
    ('hacker-news', 'hacker news'),
    ('hacker-news', 'hnrss'),
    ('ai-news', 'artificialintelligence-news'),
    ('stanford', 'stanford'),
    ('microsoft', 'microsoft'),
    ('microsoft', 'blogs.microsoft.com'),
    ('bbc', 'bbc'),
    ('bbc', 'bbc future'),
    ('openai', 'openai'),
    ('openai', 'codex'),
    ('google', 'gemini'),
    ('google', 'google'),
    ('xai', 'xai'),
    ('xai', 'grok'),
    ('developer-tools', 'claude code'),
    ('developer-tools', 'codex'),
    ('developer-tools', 'plugin'),
    ('developer-tools', 'sdk'),
    ('developer-tools', 'developer'),
    ('developer-tools', 'github actions'),
    ('ai-agents', 'agent'),
    ('ai-agents', 'assistant'),
    ('infrastructure', 'cloud'),
    ('infrastructure', 'infrastructure'),
    ('infrastructure', 'data center'),
    ('infrastructure', 'electricity'),
    ('infrastructure', 'aws'),
    ('infrastructure', 'railway'),
    ('funding', 'ipo'),
    ('funding', 'funding'),
    ('funding', 'financing'),
    ('funding', '融资'),
    ('funding', 'revenue'),
    ('funding', 'valuation'),
    ('security', 'security'),
    ('security', '安全'),
    ('research', 'research'),
    ('research', 'study'),
    ('research', '研究'),
    ('research', 'paper'),
    ('research', 'benchmark'),
    ('research', 'institute'),
    ('policy', 'policy'),
    ('policy', 'government'),
    ('policy', 'senator'),
    ('policy', 'lawsuit'),
    ('policy', '禁令'),
    ('policy', '国防部'),
    ('policy', '白宫'),
    ('semiconductors', 'chip'),
    ('semiconductors', 'memory'),
    ('semiconductors', 'semiconductor'),
    ('semiconductors', 'hynix'),
    ('semiconductors', 'gpu'),
    ('robotics', 'robot'),
    ('robotics', '机器人'),
    ('education', 'school'),
    ('education', 'education'),
    ('education', '教育'),
    ('finance', 'family office'),
    ('finance', 'softbank'),
    ('finance', 'financial'),
    ('enterprise', 'productivity'),
    ('enterprise', 'workplace'),
    ('enterprise', 'brand'),
    ('enterprise', 'microsoft ai'),
    ('math', 'math'),
    ('math', 'mathematic'),
    ('math', '数学'),
    ('social-media', 'bluesky')
)
INSERT INTO article_tags (article_id, tag_id)
SELECT DISTINCT imported.id, news_tags.id
FROM imported
JOIN rules
  ON imported.haystack LIKE '%' || lower(rules.pattern) || '%'
JOIN news_tags
  ON news_tags.slug = rules.tag_slug
ON CONFLICT DO NOTHING;

COMMIT;

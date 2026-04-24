INSERT INTO news_articles (
  slug,
  title,
  summary,
  content,
  source_name,
  source_url,
  publish_date,
  status
)
VALUES
  (
    'agent-observability-stack',
    'Agent 可观测性从实验能力转向生产基线',
    '团队开始把 tracing、session replay 与工具调用链路统一起来，让智能体不再只是可演示，而是可定位、可回滚、可审计。',
    '越来越多 AI 产品团队不再满足于 demo 级别的链路日志，而是开始把 agent 的计划、工具调用、失败重试和最终输出放到统一追踪面板中。' || E'\n\n' ||
    '这意味着智能体工程正在向传统软件工程靠拢：谁调用了什么、在哪一步失败、是否触发了高风险动作，都需要可追踪与可解释。' || E'\n\n' ||
    '对于个人网站的信息产品来说，这类变化会直接影响后台设计，未来资讯抓取、摘要生成和人工校对链路都需要有审计能力。',
    'Codex Research Desk',
    'https://example.com/agent-observability',
    NOW(),
    'published'
  ),
  (
    'inference-cost-playbook',
    '推理成本控制成为 AI 产品迭代的新主线',
    '模型能力不再是唯一门槛，提示缓存、批量执行和任务分层调度开始决定产品能否稳定上线。',
    '很多团队开始重新梳理推理链路，把高价值请求与低价值请求拆开，避免所有任务都走同一条昂贵模型路径。' || E'\n\n' ||
    '这种架构变化也会影响内容网站的实现方式，例如首页摘要可以走高质量流程，历史归档页则优先走低成本流程。' || E'\n\n' ||
    '这类能力会在本项目第二阶段的资讯处理和推荐模块中逐步引入。',
    'Codex Research Desk',
    'https://example.com/inference-costs',
    NOW() - INTERVAL '1 day',
    'published'
  ),
  (
    'open-model-governance',
    '开源模型生态正在补齐治理与发布流程',
    '从权重管理到评测基线，开源模型项目开始更强调版本纪律和可重复性，而不只是参数规模竞争。',
    '开源社区越来越关注模型发布的完整性：不仅要给出 checkpoint，还要附带评测方法、数据说明和已知限制。' || E'\n\n' ||
    '对资讯平台而言，这意味着内容整理不能只转述结论，还要把来源、版本和边界说明一起呈现。' || E'\n\n' ||
    '本项目会把来源链接与发布时间作为资讯基础字段，后续再补标签与搜索能力。',
    'Codex Research Desk',
    'https://example.com/open-model-governance',
    NOW() - INTERVAL '2 day',
    'published'
  )
ON CONFLICT (slug) DO NOTHING;

INSERT INTO news_tags (name, slug)
VALUES
  ('Agent', 'agent'),
  ('Observability', 'observability'),
  ('MLOps', 'mlops'),
  ('Inference', 'inference'),
  ('Cost', 'cost'),
  ('Architecture', 'architecture'),
  ('Open Source', 'open-source'),
  ('Governance', 'governance'),
  ('Evaluation', 'evaluation')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO article_tags (article_id, tag_id)
SELECT a.id, t.id
FROM news_articles a
JOIN news_tags t
  ON (a.slug = 'agent-observability-stack' AND t.slug IN ('agent', 'observability', 'mlops'))
  OR (a.slug = 'inference-cost-playbook' AND t.slug IN ('inference', 'cost', 'architecture'))
  OR (a.slug = 'open-model-governance' AND t.slug IN ('open-source', 'governance', 'evaluation'))
ON CONFLICT DO NOTHING;

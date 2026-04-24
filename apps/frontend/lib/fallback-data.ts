import type {
  AdminOverviewResponse,
  HealthResponse,
  NewsArticle,
  NewsListResponse,
  TodayNewsResponse
} from "./types";

const baseStories = [
  {
    id: "agent-observability-stack",
    title: "Agent 可观测性从实验能力转向生产基线",
    summary:
      "团队开始把 tracing、session replay 与工具调用链路统一起来，让智能体不再只是可演示，而是可定位、可回滚、可审计。",
    content:
      "越来越多 AI 产品团队不再满足于 demo 级别的链路日志，而是开始把 agent 的计划、工具调用、失败重试和最终输出放到统一追踪面板中。\n\n这意味着智能体工程正在向传统软件工程靠拢：谁调用了什么、在哪一步失败、是否触发了高风险动作，都需要可追踪与可解释。\n\n对于个人网站的信息产品来说，这类变化会直接影响后台设计，未来资讯抓取、摘要生成和人工校对链路都需要有审计能力。",
    sourceName: "Codex Research Desk",
    sourceUrl: "https://example.com/agent-observability",
    tags: ["Agent", "Observability", "MLOps"]
  },
  {
    id: "inference-cost-playbook",
    title: "推理成本控制成为 AI 产品迭代的新主线",
    summary:
      "模型能力不再是唯一门槛，提示缓存、批量执行和任务分层调度开始决定产品能否稳定上线。",
    content:
      "今年很多团队开始重新梳理推理链路，把高价值请求与低价值请求拆开，避免所有任务都走同一条昂贵模型路径。\n\n这种架构变化也会影响内容网站的实现方式，例如首页摘要可以走高质量流程，历史归档页则优先走低成本流程。\n\n这类能力会在本项目第二阶段的资讯处理和推荐模块中逐步引入。",
    sourceName: "Codex Research Desk",
    sourceUrl: "https://example.com/inference-costs",
    tags: ["Inference", "Cost", "Architecture"]
  },
  {
    id: "open-model-governance",
    title: "开源模型生态正在补齐治理与发布流程",
    summary:
      "从权重管理到评测基线，开源模型项目开始更强调版本纪律和可重复性，而不只是参数规模竞争。",
    content:
      "开源社区越来越关注模型发布的完整性：不仅要给出 checkpoint，还要附带评测方法、数据说明和已知限制。\n\n对资讯平台而言，这意味着内容整理不能只转述结论，还要把来源、版本和边界说明一起呈现。\n\n本项目会把来源链接与发布时间作为资讯基础字段，后续再补标签与搜索能力。",
    sourceName: "Codex Research Desk",
    sourceUrl: "https://example.com/open-model-governance",
    tags: ["Open Source", "Governance", "Evaluation"]
  },
  {
    id: "multimodal-interface-rules",
    title: "多模态产品开始回到界面纪律，而不是功能堆叠",
    summary:
      "图片、语音和文档能力越来越普遍后，真正拉开差距的是入口清晰度、反馈节奏和结果可编辑性。",
    content:
      "多模态能力的普及让产品设计重新回到基本问题：用户是否知道下一步做什么，系统是否准确暴露了状态与风险。\n\n这也是本项目在前端设计上强调极简、留白和结构清晰的原因。页面不是为了堆功能，而是为了稳定传达信息。\n\n第一阶段先用清晰的信息分层建立前台和后台入口，复杂交互留到后续迭代。",
    sourceName: "Codex Research Desk",
    sourceUrl: "https://example.com/multimodal-interface",
    tags: ["Design", "Multimodal", "Product"]
  }
] as const;

function formatIsoDayOffset(dayOffset: number, hour: number) {
  const value = new Date();
  value.setDate(value.getDate() - dayOffset);
  value.setHours(hour, 0, 0, 0);
  return value.toISOString();
}

export function createFallbackArticles(): NewsArticle[] {
  return baseStories.map((story, index) => ({
    ...story,
    publishDate: formatIsoDayOffset(index > 1 ? index - 1 : 0, 10 + index),
    status: index === 3 ? "draft" : "published"
  }));
}

export function createFallbackTodayResponse(): TodayNewsResponse {
  const articles = createFallbackArticles();
  const spotlight = articles[0];

  if (!spotlight) {
    throw new Error("Fallback articles are not available.");
  }

  return {
    generatedAt: new Date().toISOString(),
    spotlight,
    articles: articles.slice(0, 3)
  };
}

export function createFallbackNewsList(date?: string): NewsListResponse {
  const items = createFallbackArticles().filter((item) => {
    if (!date) {
      return true;
    }

    return item.publishDate.slice(0, 10) === date;
  });

  return {
    page: 1,
    pageSize: 10,
    total: items.length,
    items
  };
}

export function createFallbackHealth(): HealthResponse {
  return {
    service: "personal-ai-site-api",
    status: "ok",
    timestamp: new Date().toISOString(),
    phase: "phase-1-local-scaffold",
    modules: ["health", "news", "auth-stub", "admin-stub"],
    database: "postgres-schema-ready"
  };
}

export function createFallbackAdminOverview(): AdminOverviewResponse {
  const items = createFallbackArticles();
  return {
    totalArticles: items.length,
    publishedArticles: items.filter((item) => item.status === "published").length,
    draftArticles: items.filter((item) => item.status === "draft").length,
    plannedModules: ["JWT 登录", "RBAC 菜单控制", "资讯 CRUD", "操作日志"],
    pendingMilestones: ["M2 账号与权限", "M3 资讯后台", "M4 服务器部署"]
  };
}

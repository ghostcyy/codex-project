import type { EvidencePack } from "../ir";

export type ResearchQueryKind = "web-fact" | "web-stat" | "image" | "paper" | "terminology";

export type ResearchQuery = {
  query: string;
  kind: ResearchQueryKind;
  intentLabel: string;
  priority: number;
};

export type ResearchHit = {
  query: ResearchQuery;
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
  sourceType: EvidencePack["facts"][number]["sources"][number]["type"];
};

export type ResearchClient = {
  search(queries: ResearchQuery[]): Promise<ResearchHit[]>;
};

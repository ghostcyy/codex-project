import type { GenerateRequest, PptV3Job } from "../shared";

export const PPT_V3_MESSAGE_ROLES = ["user", "assistant"] as const;
export type PptV3MessageRole = (typeof PPT_V3_MESSAGE_ROLES)[number];

export const PPT_V3_MESSAGE_KINDS = ["text", "clarification", "job", "error"] as const;
export type PptV3MessageKind = (typeof PPT_V3_MESSAGE_KINDS)[number];

export type PptV3Project = {
  id: string;
  userId: string | null;
  ownerUserId: number | null;
  title: string;
  selectedTemplateId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PptV3Message = {
  id: string;
  projectId: string;
  role: PptV3MessageRole;
  content: string;
  kind: PptV3MessageKind;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

export type CreatePptV3ProjectInput = {
  userId?: unknown;
  ownerUserId?: unknown;
  title?: unknown;
  selectedTemplateId?: unknown;
  templateId?: unknown;
};

export type PostPptV3ProjectMessageInput = {
  content?: unknown;
  metadata?: unknown;
  theme?: unknown;
  topic?: unknown;
  pageCount?: unknown;
  wordBudget?: unknown;
  templateId?: unknown;
  selectedTemplateId?: unknown;
  includeImages?: unknown;
  includeVideo?: unknown;
  includeChart?: unknown;
  includeAudio?: unknown;
  includeSpeakerNotes?: unknown;
};

export type PptV3PostMessageResult = {
  project: PptV3Project;
  userMessage: PptV3Message;
  assistantMessage: PptV3Message;
  request?: GenerateRequest;
  warnings?: string[];
  job?: PptV3Job;
};

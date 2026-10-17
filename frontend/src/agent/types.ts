// Agent Mode contract (docs/superpowers/specs/2026-10-17-agent-mode-design.md).
// Shared by the backend (/api/agent/plan, /api/agent/critique), agent.ts, review.ts and the chat UI.
import type { DesignSummary } from '../design';
import type { Op, Slots } from '../types';

export interface AgentQuestion {
  id: string;
  q: string;
  /** 2-4 clickable answers; the UI always adds an "Other…" free-text choice. */
  options: string[];
  /** Several answers may be picked (e.g. "Which businesses?"); the answer is sent as "A, B, C". */
  multi?: boolean;
}

/** 'warn' = finished but below the bar (review: score < PASS_SCORE or a brief miss left) -> amber "⚠ 77 · needs work". */
export type AgentStepStatus = 'pending' | 'running' | 'done' | 'warn' | 'failed' | 'skipped';

/** One line of a live checklist in a chat message (multi-step requests and the review trace). */
export interface AgentStep {
  id: string;
  label: string;
  status: AgentStepStatus;
  /** Optional right-aligned detail, e.g. "72 → 88". */
  detail?: string;
  /** Agent role shown as a pill and card tint (spec §8 C). */
  role?: AgentRole;
  /** Small glyph shown before the label. */
  icon?: string;
  /** Mini chips under the label (the Brand Kit card). */
  chips?: string[];
  /** Expandable "thinking" behind the card (click to open): what this role saw, decided and why. */
  thinking?: StepThought[];
}

/** One titled section of a card's thinking, e.g. { title: 'Round 1 · vision', lines: ['Score 72', 'Head cut by the bloom'] }. */
export interface StepThought {
  title: string;
  lines: string[];
}

export type AgentRole = 'strategist' | 'producer' | 'art-director';

export type PlanAction = 'ask' | 'create' | 'edit' | 'recreate' | 'variations' | 'resize' | 'fix' | 'chat' | 'steps';
export type StepAction = 'edit' | 'resize' | 'fix';
export type SizeKeyLike = '4:5' | '1:1' | '9:16';

export interface PlanContext {
  hasDesign: boolean;
  design?: DesignSummary;
  slots?: Slots;
  selectedRefId?: string | null;
  /** Headline of the selected reference, so the planner knows what "like this" points at. */
  selectedRefHeadline?: string | null;
  /** The active design is an imported flat image / upload. */
  hasUpload: boolean;
  /** Confirmed "what I see" analysis of the upload, if any. */
  uploadAnalysis?: Record<string, unknown> | null;
  /** Answers to the previous round of questions (question text -> answer). */
  answers?: Record<string, string> | null;
  /** True on the call after a question round: the planner must act, never ask again. */
  askedAlready: boolean;
}

export interface PlanRequest {
  message: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  context: PlanContext;
}

export interface PlanStep {
  action: StepAction;
  prompt: string;
  label: string;
}

export interface PlanResponse {
  /** One line: what the agent understood the user wants. */
  understanding: string;
  action: PlanAction;
  /** Only for action 'ask': 1-3 questions. */
  questions: AgentQuestion[];
  /** Rewritten request for the existing endpoint (concepts / edit). */
  prompt: string;
  /** Facts merged from answers + message, passed as `brief` to /api/design/concepts. */
  brief: string | null;
  /** Number of designs for create/variations, 1-8. */
  count: number;
  size: SizeKeyLike | null;
  /** Only for action 'steps': 2-5 ordered steps on the active design. */
  steps: PlanStep[];
  /** Text reply for action 'chat' (also used as a friendly line for other actions). */
  reply: string;
  /** One subject per design, in order, when the user named them ("bakery owner", "florist", "restaurant owner").
   *  Length <= count; empty = no explicit subjects. */
  subjects: string[];
  /** Campaign theme that must be visible in copy AND photo scene (e.g. "Christmas"); null = none. */
  theme: string | null;
  /** Concrete must-haves the Art Director checks every design against (max 6), e.g. "Christmas theme visible". */
  requirements: string[];
}

export interface CritiqueRequest {
  /** JPEG data URL of the rendered design (longest side ~768px). Omitted -> text-only critique. */
  image?: string;
  design: DesignSummary;
  slots?: Slots;
  brief?: string;
  /** Brand checker issue messages for this design. */
  brandIssues: string[];
  /** 0 = first look, 1 = after the first fix, ... */
  round: number;
  /** Must-haves for THIS design: plan.requirements + its own subject ("Photo shows a restaurant owner"). */
  requirements?: string[];
}

export interface CritiqueResponse {
  visionScore: number;
  verdict: 'pass' | 'fix';
  issues: string[];
  /** Max 4; update | rebuild | delete | reorder | reframe (photo crop fix, applied like any sync op), plus at most one `photo` op on the hero photo layer when the
   *  photo misses a requirement (wrong subject / theme not visible); its prompt names subject + themed scene. */
  ops: Op[];
  /** Requirements this design misses (empty = all met). Any miss forces verdict 'fix' and visionScore <= 70. */
  briefMisses: string[];
  /** Max 3 follow-up requests phrased as the user would type them ("Make a 9:16 story version"). */
  suggestions: string[];
  summary: string;
  usedVision: boolean;
}

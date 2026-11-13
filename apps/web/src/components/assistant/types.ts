/**
 * What the assistant routes in `apps/api/src/routes/ai.ts` answer, as it arrives over JSON
 * (timestamps are ISO strings). The web app does not depend on `@pms/ai`, so the shapes are
 * written out here; each names the backend type it mirrors and must follow it.
 */

/** Mirrors `AiActionStatus` in `packages/db/src/schema/enums.ts`. */
export type AiActionStatus = 'proposed' | 'confirmed' | 'rejected' | 'expired' | 'failed';

/** Mirrors `AiActionRow` (a row of `ai_actions`) in `packages/ai/src/copilot/copilot.ts`. */
export interface AiAction {
  id: string;
  orgId: string;
  userId: string;
  propertyId: string | null;
  tool: string;
  params: Record<string, unknown>;
  /** What will happen, in a sentence the person reads before confirming. */
  summary: string;
  status: AiActionStatus;
  result: Record<string, unknown> | null;
  error: string | null;
  expiresAt: string;
  decidedAt: string | null;
  createdAt: string;
}

/** Mirrors `CopilotReply` in `packages/ai/src/copilot/copilot.ts`. */
export interface CopilotReply {
  reply: string;
  actions: AiAction[];
  /** `rules` when no AI service is configured and the built-in commands answered. */
  mode: 'llm' | 'rules';
  toolsUsed: string[];
  /** What the AI service said when it failed and the fixed requests answered in its place. */
  serviceDown?: string;
}

/** Mirrors `CopilotTurn` in `packages/ai/src/copilot/copilot.ts`. */
export interface CopilotTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Mirrors what `confirmAction` returns in `packages/ai/src/copilot/copilot.ts`. */
export type ConfirmedAction = AiAction & { message: string };

/** Mirrors the answer of `GET /ai/status` in `apps/api/src/routes/ai.ts`. */
export interface AiStatus {
  provider: string | null;
  model: string | null;
  documentCapture: boolean;
}

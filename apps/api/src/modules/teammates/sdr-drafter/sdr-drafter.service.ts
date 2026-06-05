import type { PrismaClient } from '@prisma/client';
import type { LlmProvider } from '../runtime/llm-provider';
import { runAgent, type RunAgentResult } from '../runtime/tool-use-loop';
import type { AgentTool } from '../runtime/agent-tool';
import { webSearchTool } from '../runtime/tools/web-search';
import { fetchUrlTool } from '../runtime/tools/fetch-url';
import { getContactTool } from '../runtime/tools/get-contact';
import { getResearchBriefTool } from '../runtime/tools/get-research-brief';
import type { RunEvent } from '../runtime/run-event-bus';
import {
  buildSdrDrafterUserPrompt,
  SDR_DRAFTER_SYSTEM_PROMPT,
} from './sdr-drafter.prompts';

/**
 * SDR Drafter teammate service (T9.5).
 *
 * Mirrors researcher.service.ts. The only meaningful differences:
 *   - Tool allowlist adds get_contact + get_research_brief (read-only
 *     internal data accessors).
 *   - draftRecipient is resolved server-side from contactId and threaded
 *     through to persistDraftFromEmitArgs so Draft.recipient is populated
 *     without trusting model output.
 *
 * Same model defaults as the Researcher (claude-sonnet-4-6 — drafting
 * needs reasoning over the brief, not Haiku's speed).
 */

export interface SdrDrafterInput {
  orgId: string;
  triggeredBy: string;
  contactId: string;
  /**
   * AgentRun.id — created by the controller before enqueuing, threaded
   * through the worker job. The service does not create AgentRuns; that
   * stays with the controller so the caller has a runId to poll on.
   */
  runId: string;
  briefDraftId?: string | null;
  goal?: string | null;
  modelName?: string;
  budgetCents?: number;
  maxToolCalls?: number;
  maxWallSecs?: number;
}

export interface SdrDrafterDeps {
  prisma: PrismaClient;
  llm: LlmProvider;
  tools?: AgentTool[];
  emitEvent?: (event: RunEvent) => void;
}

export interface SdrDrafterResult {
  runId: string;
  status: RunAgentResult['status'];
  reason?: string;
  draftId?: string;
  costCents: number;
  toolCallCount: number;
}

export const SDR_DRAFTER_NAME = 'sdr-drafter';

const DEFAULTS = {
  modelName: 'claude-sonnet-4-6',
  budgetCents: 50,
  maxToolCalls: 15,
  maxWallSecs: 120,
} as const;

export async function runSdrDrafter(
  deps: SdrDrafterDeps,
  input: SdrDrafterInput,
): Promise<SdrDrafterResult> {
  // Resolve recipient. The controller already validated existence + that
  // the contact has an email + cross-org safety; this is the read we need
  // for Draft.recipient (server-controlled, never model-controlled). The
  // non-null assertion on normalizedEmail is safe because the controller
  // 400s when email is missing — but we keep the type-checked field.
  const contact = await deps.prisma.contact.findFirstOrThrow({
    where: { id: input.contactId, orgId: input.orgId },
  });
  const recipientEmail = contact.normalizedEmail ?? '';
  const recipientName =
    [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() ||
    null;

  const tools = deps.tools ?? [
    getContactTool,
    getResearchBriefTool,
    webSearchTool,
    fetchUrlTool,
  ];

  const result = await runAgent({
    runId: input.runId,
    orgId: input.orgId,
    teammate: SDR_DRAFTER_NAME,
    modelName: input.modelName ?? DEFAULTS.modelName,
    systemPrompt: SDR_DRAFTER_SYSTEM_PROMPT,
    userPrompt: buildSdrDrafterUserPrompt({
      contactId: input.contactId,
      briefDraftId: input.briefDraftId ?? null,
      goal: input.goal ?? null,
    }),
    tools,
    budgetCents: input.budgetCents ?? DEFAULTS.budgetCents,
    maxToolCalls: input.maxToolCalls ?? DEFAULTS.maxToolCalls,
    maxWallSecs: input.maxWallSecs ?? DEFAULTS.maxWallSecs,
    prisma: deps.prisma,
    llm: deps.llm,
    emitEvent: deps.emitEvent,
    draftRecipient: {
      contactId: contact.id,
      email: recipientEmail,
      name: recipientName,
    },
  });

  return {
    runId: input.runId,
    status: result.status,
    reason: result.reason,
    draftId: result.draftId,
    costCents: result.costCents,
    toolCallCount: result.toolCallCount,
  };
}

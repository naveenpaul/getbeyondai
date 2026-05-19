import type { PrismaClient } from '@prisma/client';
import type { AnthropicMessagesClient } from '../runtime/call-model';
import { runAgent, type RunAgentResult } from '../runtime/tool-use-loop';
import type { AgentTool } from '../runtime/agent-tool';
import { braveSearchTool } from '../runtime/tools/brave-search';
import { fetchUrlTool } from '../runtime/tools/fetch-url';
import {
  buildResearcherUserPrompt,
  RESEARCHER_SYSTEM_PROMPT,
} from './researcher.prompts';

/**
 * Researcher teammate service (T4c).
 *
 * Creates an AgentRun + drives it via the runtime tool-use loop. The
 * intelligence layer is just orchestration: pick the tool allowlist + bounds
 * for the Researcher, hand off to runAgent.
 *
 * What's specific to the Researcher (vs other teammates):
 *   - Tool allowlist: brave_search + fetch_url + (emit_draft, appended by the
 *     runtime). No CRM tools, no email send — Researcher is read-only.
 *   - Default model: claude-sonnet-4-6 — Researcher needs reasoning over
 *     citations, not Haiku's speed.
 *   - Default budget: $0.50 per run (50¢). Designed to hold under the
 *     plan's <$0.10 Brave + ~$0.40 model spend target.
 *   - Bounds: maxToolCalls=20 (enough for 10 search/fetch pairs +
 *     emit_draft retries), maxWallSecs=120 (Researcher is async, not
 *     interactive — 2 min is fine).
 */

export interface ResearchInput {
  orgId: string;
  /** User identifier from auth context, or 'system' for scheduled runs. */
  triggeredBy: string;
  /**
   * What to research. Can be a URL, a company name, a contact name, or a
   * free-text question ("tell me about competitor X's pricing"). The
   * Researcher prompt handles all three shapes.
   */
  target: string;
  /**
   * Optional: reuse an existing AgentRun row. When provided, runResearch
   * skips AgentRun.create and drives the existing row to terminal. This is
   * how the async-worker pattern (T4d) hands work off: the controller
   * creates the run synchronously to return a runId immediately, then the
   * worker picks up the job and calls runResearch with this field set.
   */
  runId?: string;
  /** Optional overrides. Production callers stick with defaults. */
  modelName?: string;
  budgetCents?: number;
  maxToolCalls?: number;
  maxWallSecs?: number;
}

export interface ResearchDeps {
  prisma: PrismaClient;
  anthropic: AnthropicMessagesClient;
  /** Optional tool overrides for tests (default: brave + fetch). */
  tools?: AgentTool[];
}

export interface ResearchResult {
  /** AgentRun.id — the audit-log primary key for this research session. */
  runId: string;
  /** Final state. completed=success, abstained=ran but no/insufficient draft. */
  status: RunAgentResult['status'];
  /** When status=abstained, names the bound or reason. */
  reason?: string;
  /** Persisted Draft.id (only when status=completed). */
  draftId?: string;
  /** Total cost across all model + tool calls. */
  costCents: number;
  /** Tool-call count (audit transparency). */
  toolCallCount: number;
}

export const RESEARCHER_NAME = 'researcher';

const DEFAULTS = {
  modelName: 'claude-sonnet-4-6',
  budgetCents: 50,
  maxToolCalls: 20,
  maxWallSecs: 120,
} as const;

export async function runResearch(
  deps: ResearchDeps,
  input: ResearchInput,
): Promise<ResearchResult> {
  // Reuse a pre-created AgentRun (async-worker path) or create one inline
  // (sync path / direct service callers). Either way, the loop transitions
  // the row to terminal.
  let runId = input.runId;
  if (!runId) {
    const run = await deps.prisma.agentRun.create({
      data: {
        orgId: input.orgId,
        teammate: RESEARCHER_NAME,
        triggeredBy: input.triggeredBy,
        status: 'running',
        inputContext: { target: input.target } satisfies Record<string, unknown>,
      },
    });
    runId = run.id;
  }

  const tools = deps.tools ?? [braveSearchTool, fetchUrlTool];

  const result = await runAgent({
    runId,
    orgId: input.orgId,
    teammate: RESEARCHER_NAME,
    modelName: input.modelName ?? DEFAULTS.modelName,
    systemPrompt: RESEARCHER_SYSTEM_PROMPT,
    userPrompt: buildResearcherUserPrompt(input.target),
    tools,
    budgetCents: input.budgetCents ?? DEFAULTS.budgetCents,
    maxToolCalls: input.maxToolCalls ?? DEFAULTS.maxToolCalls,
    maxWallSecs: input.maxWallSecs ?? DEFAULTS.maxWallSecs,
    prisma: deps.prisma,
    anthropic: deps.anthropic,
  });

  return {
    runId,
    status: result.status,
    reason: result.reason,
    draftId: result.draftId,
    costCents: result.costCents,
    toolCallCount: result.toolCallCount,
  };
}

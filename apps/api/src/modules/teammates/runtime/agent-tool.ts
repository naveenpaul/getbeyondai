import type { PrismaClient } from '@prisma/client';

/**
 * Contract every teammate-callable tool implements (T4b.1).
 *
 * A tool is just: (name, schema, run). The runtime hands it a JSON-shaped
 * args object the model produced, plus a context for DB writes (Citation
 * inserts, etc.). The tool returns whatever JSON-serializable value should
 * land in the tool_result block for the next model turn.
 *
 * Tools that need to influence the audit log (every fetch_url, every
 * web_search) write to `Citation` directly inside `execute`. The runtime
 * doesn't intermediate that — it only knows about the tool's name, args,
 * and return value, which get logged as a `ToolCall` row.
 *
 * Tool input validation is the tool's own job. Most implementations Zod-parse
 * `args` first thing. Validation errors propagate as thrown Errors; the loop
 * surfaces them to the model via `is_error: true` so the next turn can
 * recover.
 */
export interface ToolContext {
  /** AgentRun.id — for attributing Citations / additional ToolCalls. */
  runId: string;
  /** Owner org — for any tenant-scoped writes. */
  orgId: string;
  /** Prisma client. Tools that mutate (e.g. add Citation rows) use this. */
  prisma: PrismaClient;
}

export interface AgentTool {
  /** Name surfaced to the model. Must match the tool name the provider returns
   *  in its tool calls (provider-neutral — Anthropic, OpenAI, etc.). */
  name: string;
  /** Description surfaced to the model. */
  description: string;
  /** JSON Schema for the input. */
  inputSchema: object;
  /**
   * Execute the tool. Throw on errors — the loop catches + reports to the model.
   * Return any JSON-serializable value; the loop stringifies it for the
   * tool_result block.
   */
  execute(args: unknown, ctx: ToolContext): Promise<unknown>;
}

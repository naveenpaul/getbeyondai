import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QueueService } from '../queue/queue.service';

export const AGENT_RUN_REAPER_QUEUE = 'reap-stale-agent-runs';

/**
 * Default staleness threshold on AgentRun.lastBeatAt. Teammates legitimately
 * spend minutes in long Researcher loops; callModel bumps lastBeatAt on
 * every model turn so any running, healthy run advances the heartbeat
 * within seconds. 5 min without a beat means the worker process is gone.
 *
 * The runtime's `maxWallSecs` default is 120s, so even a near-bound-trip
 * run beats well inside this window.
 */
export const AGENT_RUN_STALE_MS = 5 * 60 * 1000;

/** Cron: every 2 min. */
export const AGENT_RUN_REAPER_CRON = '*/2 * * * *';

/**
 * AgentRun stale-running reaper (T4d.3 + eng-review pass-1 Issue 2A).
 *
 * The plan calls for full state-machine coverage of AgentRun: heartbeat,
 * reaper, idempotent ToolCall inserts. callModel handles the heartbeat
 * (every model turn updates lastBeatAt); the unique (runId, toolSeq)
 * constraint covers idempotency; this reaper covers the case where a
 * worker process dies mid-flight and never marks the run terminal.
 *
 * Reaped runs land at status='failed' with reason='stale_run' so the
 * /audit page can surface them. Cost + tool_call rows are preserved (the
 * partial work is auditable even when the worker crashed).
 */
@Injectable()
export class AgentRunReaper implements OnModuleInit {
  private readonly logger = new Logger(AgentRunReaper.name);
  private readonly prisma: PrismaService;
  private readonly queue: QueueService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(QueueService) queue: QueueService,
  ) {
    this.prisma = prisma;
    this.queue = queue;
  }

  async onModuleInit(): Promise<void> {
    await this.queue.work(AGENT_RUN_REAPER_QUEUE, async () => {
      const reaped = await this.reap();
      if (reaped > 0) {
        this.logger.log(`reaped ${reaped} stale AgentRun(s)`);
      }
    });
    await this.queue.schedule(AGENT_RUN_REAPER_QUEUE, AGENT_RUN_REAPER_CRON);
    this.logger.log(
      `scheduled AgentRun reaper (cron="${AGENT_RUN_REAPER_CRON}", threshold=${AGENT_RUN_STALE_MS / 1000}s)`,
    );
  }

  /**
   * Mark any AgentRun stuck in status='running' past the staleness window
   * as failed. Returns the count of reaped rows. Exposed (vs private) so
   * tests can drive the logic without waiting for a cron tick.
   *
   * Optional params for tests:
   *   - now: clock injection
   *   - staleMs: shorter threshold for fast tests
   */
  async reap(
    now: Date = new Date(),
    staleMs: number = AGENT_RUN_STALE_MS,
  ): Promise<number> {
    const cutoff = new Date(now.getTime() - staleMs);
    const result = await this.prisma.agentRun.updateMany({
      where: {
        status: 'running',
        lastBeatAt: { lt: cutoff },
      },
      data: {
        status: 'failed',
        reason: 'stale_run',
        completedAt: now,
      },
    });
    return result.count;
  }
}

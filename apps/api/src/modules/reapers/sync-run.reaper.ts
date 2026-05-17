import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QueueService } from '../queue/queue.service';

export const SYNC_RUN_REAPER_QUEUE = 'reap-stale-sync-runs';

/**
 * Default staleness window. A SyncRun stuck in `running` past this is
 * almost certainly from a crashed worker (the CSV import jobs typically
 * complete in seconds; even a 50k-row CSV finishes inside 60s). 15 min
 * leaves enough headroom for genuinely slow runs while still surfacing
 * crashes within a reasonable window.
 */
export const SYNC_RUN_STALE_MS = 15 * 60 * 1000;

/** Cron: every 5 min. */
export const SYNC_RUN_REAPER_CRON = '*/5 * * * *';

@Injectable()
export class SyncRunReaper implements OnModuleInit {
  private readonly logger = new Logger(SyncRunReaper.name);
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
    // Register the worker FIRST so a stale `boss.schedule` row that already
    // exists in pg-boss state has somewhere to dispatch to on the next tick.
    await this.queue.work(SYNC_RUN_REAPER_QUEUE, async () => {
      const reaped = await this.reap();
      if (reaped > 0) {
        this.logger.log(`reaped ${reaped} stale SyncRun(s)`);
      }
    });
    await this.queue.schedule(SYNC_RUN_REAPER_QUEUE, SYNC_RUN_REAPER_CRON);
    this.logger.log(
      `scheduled SyncRun reaper (cron="${SYNC_RUN_REAPER_CRON}", threshold=${SYNC_RUN_STALE_MS / 1000}s)`,
    );
  }

  /**
   * Find SyncRuns stuck in `running` past the staleness window and mark them
   * `failed`. Returns the count of rows reaped. Exposed (vs private) so
   * tests can drive the logic directly without waiting for a cron tick.
   *
   * Optional params for tests:
   *   - `now`: clock injection
   *   - `staleMs`: shorter threshold for fast tests
   */
  async reap(
    now: Date = new Date(),
    staleMs: number = SYNC_RUN_STALE_MS,
  ): Promise<number> {
    const cutoff = new Date(now.getTime() - staleMs);
    const reaperError: Prisma.InputJsonValue = [
      {
        row: -1,
        reason: 'stale_run',
        message: `Reaper marked stale — no terminal status after ${Math.round(staleMs / 1000)}s`,
      },
    ];
    const result = await this.prisma.syncRun.updateMany({
      where: {
        status: 'running',
        startedAt: { lt: cutoff },
      },
      data: {
        status: 'failed',
        completedAt: now,
        errors: reaperError,
        errorCount: { increment: 1 },
      },
    });
    return result.count;
  }
}

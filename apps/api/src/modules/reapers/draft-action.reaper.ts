import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QueueService } from '../queue/queue.service';

export const DRAFT_ACTION_REAPER_QUEUE = 'reap-stale-draft-actions';

/**
 * DraftActions should complete in well under a minute (echo destinations
 * are sub-second; real vendor calls cap at ~30s timeout). 5 min in `running`
 * means a worker crashed mid-execute or got SIGKILLed.
 */
export const DRAFT_ACTION_STALE_MS = 5 * 60 * 1000;

/** Cron: every 2 min. Tighter than SyncRun because DraftActions are quicker. */
export const DRAFT_ACTION_REAPER_CRON = '*/2 * * * *';

@Injectable()
export class DraftActionReaper implements OnModuleInit {
  private readonly logger = new Logger(DraftActionReaper.name);
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
    await this.queue.work(DRAFT_ACTION_REAPER_QUEUE, async () => {
      const reaped = await this.reap();
      if (reaped > 0) {
        this.logger.log(`reaped ${reaped} stale DraftAction(s)`);
      }
    });
    await this.queue.schedule(
      DRAFT_ACTION_REAPER_QUEUE,
      DRAFT_ACTION_REAPER_CRON,
    );
    this.logger.log(
      `scheduled DraftAction reaper (cron="${DRAFT_ACTION_REAPER_CRON}", threshold=${DRAFT_ACTION_STALE_MS / 1000}s)`,
    );
  }

  /**
   * Find DraftActions stuck in `running` past the staleness window and mark
   * them `failed` with a stale diagnostic. Returns the reaped row count.
   *
   * Optional params for tests:
   *   - `now`: clock injection
   *   - `staleMs`: shorter threshold for fast tests
   */
  async reap(
    now: Date = new Date(),
    staleMs: number = DRAFT_ACTION_STALE_MS,
  ): Promise<number> {
    const cutoff = new Date(now.getTime() - staleMs);
    const diagnostic: Prisma.InputJsonValue = {
      reason: 'stale_run',
      message: `Reaper marked stale — DraftAction status='running' for >${Math.round(staleMs / 1000)}s`,
    };
    const result = await this.prisma.draftAction.updateMany({
      where: {
        status: 'running',
        updatedAt: { lt: cutoff },
      },
      data: {
        status: 'failed',
        responsePayload: diagnostic,
        executedAt: now,
      },
    });
    return result.count;
  }
}

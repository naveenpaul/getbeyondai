import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import PgBoss from 'pg-boss';

/**
 * pg-boss-backed job queue (eng-review pass-1 tech-stack decision: pg-boss
 * over BullMQ+Redis for self-host simplicity).
 *
 * Single shared pg-boss instance per Node process. Connects to the same
 * Postgres as Prisma (DATABASE_URL); creates + migrates its own `pgboss`
 * schema on start(). Per-job stats, retries, archive, and at-least-once
 * delivery are all built-in.
 *
 * Scale trigger from eng-review Issue 3D (pass-1): migrate cloud to
 * BullMQ+Redis when job-pickup p99 > 5s OR Postgres CPU > 5% on pg-boss
 * queries OR concurrent active runs > 200 in a 1-min window. Until then,
 * pg-boss is the single-binary win for self-host users.
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private boss?: PgBoss;
  private readonly declaredQueues = new Set<string>();

  /**
   * Connects to pg-boss and bootstraps its schema. Safe to call multiple
   * times — the second call is a no-op while the boss is running.
   */
  async onModuleInit(): Promise<void> {
    if (this.boss) return;
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error('QueueService requires DATABASE_URL to be set');
    }
    this.boss = new PgBoss({
      connectionString: url,
      schema: 'pgboss',
    });
    this.boss.on('error', (err) =>
      this.logger.error(`pg-boss error: ${err.message}`, err.stack),
    );
    await this.boss.start();
    this.logger.log('pg-boss started');
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.boss) return;
    // graceful: wait for in-flight jobs (with a short timeout) before close.
    await this.boss.stop({ graceful: true, close: true });
    this.boss = undefined;
    this.declaredQueues.clear();
  }

  /**
   * Enqueue a job onto `queue`. Returns the job ID for tracking, or null if
   * deduplication / throttling suppressed it.
   */
  async send<T extends object>(
    queue: string,
    data: T,
    options?: PgBoss.SendOptions,
  ): Promise<string | null> {
    const boss = this.requireBoss();
    await this.ensureQueue(queue, boss);
    return boss.send(queue, data, options ?? {});
  }

  /**
   * Register a worker for `queue`. Handler is called for each job; if it
   * throws, pg-boss applies its retry policy and eventually dead-letters.
   * Returns the worker registration ID so callers can stop a specific worker
   * later if needed.
   */
  async work<T extends object>(
    queue: string,
    handler: (job: PgBoss.Job<T>) => Promise<void>,
  ): Promise<string> {
    const boss = this.requireBoss();
    await this.ensureQueue(queue, boss);
    return boss.work<T>(queue, async (jobs) => {
      // pg-boss v10 hands an array of jobs (batch mode); process serially.
      for (const job of jobs) {
        await handler(job);
      }
    });
  }

  /**
   * Internal accessor exposed for tests that need to drain queues or poke
   * pg-boss directly. NOT for production code — go through send / work.
   */
  getRawBossForTestingOnly(): PgBoss | undefined {
    return this.boss;
  }

  private requireBoss(): PgBoss {
    if (!this.boss) {
      throw new Error(
        'QueueService not started — onModuleInit has not run (or the app is shutting down)',
      );
    }
    return this.boss;
  }

  private async ensureQueue(queue: string, boss: PgBoss): Promise<void> {
    if (this.declaredQueues.has(queue)) {
      return;
    }
    await boss.createQueue(queue);
    this.declaredQueues.add(queue);
  }
}

import { log } from './logger.js';
import type { Store } from './types.js';
import { ConsolidationAgent } from './consolidation.js';
import type { LLMProvider } from './consolidation.js';

export interface ConsolidationWorkerOptions {
  store: Store;
  llmProvider: LLMProvider;
  pollingIntervalMs?: number;
  maxCandidates?: number;
}

export class ConsolidationWorker {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private currentJobPromise: Promise<void> | null = null;
  private agent: ConsolidationAgent;
  private pollingIntervalMs: number;

  constructor(private options: ConsolidationWorkerOptions) {
    this.pollingIntervalMs = options.pollingIntervalMs ?? 5000;
    this.agent = new ConsolidationAgent(options.store, {
      llmProvider: options.llmProvider,
      maxMemoriesPerCycle: options.maxCandidates ?? 5,
    });
  }

  start(): void {
    if (this.running) {
      log('consolidation-worker', 'Worker already running');
      return;
    }

    this.running = true;
    log('consolidation-worker', 'Worker started, polling every ' + this.pollingIntervalMs + 'ms');
    this.scheduleNextPoll();
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    log('consolidation-worker', 'Stopping worker...');
    this.running = false;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.currentJobPromise) {
      log('consolidation-worker', 'Waiting for current job to complete...');
      try {
        await this.currentJobPromise;
      } catch {
      }
    }

    log('consolidation-worker', 'Worker stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  private scheduleNextPoll(): void {
    if (!this.running) return;

    this.timer = setTimeout(async () => {
      if (!this.running) return;

      try {
        const processed = await this.processNextJob();
        if (processed) {
          this.scheduleNextPoll();
        } else {
          this.scheduleNextPoll();
        }
      } catch (err) {
        log('consolidation-worker', 'Poll cycle error: ' + (err instanceof Error ? err.message : String(err)));
        this.scheduleNextPoll();
      }
    }, this.pollingIntervalMs);
  }

  private async processNextJob(): Promise<boolean> {
    const job = this.options.store.getNextPendingJob();
    if (!job) {
      return false;
    }

    log('consolidation-worker', 'Processing job ' + job.id + ' for document ' + job.document_id);
    this.options.store.updateJobStatus(job.id, 'processing');

    this.currentJobPromise = this.agent.processConsolidationJob(job.id, job.document_id);

    try {
      await this.currentJobPromise;
      log('consolidation-worker', 'Job ' + job.id + ' completed');
      return true;
    } catch (err) {
      log('consolidation-worker', 'Job ' + job.id + ' failed: ' + (err instanceof Error ? err.message : String(err)));
      return true;
    } finally {
      this.currentJobPromise = null;
    }
  }
}

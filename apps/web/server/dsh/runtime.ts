import { DeepSeekHarness, type HarnessSession, type RunResult } from '@deepseek-ai/dsh-sdk-client';
import { loadAgentConfig } from '../agent.ts';
import { logger } from '../logger.ts';
import {
  assertDshNode,
  DSH_INIT_TIMEOUT_MS,
  DSH_MODEL,
  DSH_PROVIDER,
  DSH_REASONING_EFFORT,
  DSH_SESSION_IDLE_MS,
  DSH_WORKSPACE,
} from './config.ts';
import { createNotificationMapper, type DshNotificationEvent } from './notify.ts';

type HarnessOptions = NonNullable<ConstructorParameters<typeof DeepSeekHarness>[0]>;
type SessionInput = Parameters<HarnessSession['run']>[0];

export type DshRuntimeOptions = {
  patchFile: string;
  dshHome: string;
  requestTimeoutMs: number;
  /** Idle timeout for cached sessions; 0 disables eviction. */
  idleMs?: number;
};

export type RunOptions = {
  /** Restore the persisted session when it exists instead of creating a new one. */
  resume?: boolean;
};

/**
 * One dsh runtime process shared by many sessions. Both AI features build on
 * this class so they differ only in prompt, tool server and event adapter.
 */
export class DshRuntime {
  private readonly options: DshRuntimeOptions;
  private harness: DeepSeekHarness | null = null;
  private readonly sessions = new Map<string, HarnessSession>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly active = new Set<string>();
  private readonly lastUsed = new Map<string, number>();
  private evictTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(options: DshRuntimeOptions) {
    this.options = options;
  }

  private getHarness(): DeepSeekHarness {
    if (this.harness) return this.harness;
    assertDshNode();
    const options: HarnessOptions = {
      profile: 'sdk',
      patches: [this.options.patchFile],
      dshHome: this.options.dshHome,
      cwd: DSH_WORKSPACE,
      processCwd: DSH_WORKSPACE,
      initializeTimeoutMs: DSH_INIT_TIMEOUT_MS,
      requestTimeoutMs: this.options.requestTimeoutMs,
      provider: DSH_PROVIDER,
      model: DSH_MODEL,
    };
    options.reasoningEffort = DSH_REASONING_EFFORT as NonNullable<HarnessOptions['reasoningEffort']>;
    const agent = loadAgentConfig();
    if (agent.key) options.env = { ...process.env, DEEPSEEK_API_KEY: agent.key };
    this.harness = new DeepSeekHarness(options);
    return this.harness;
  }

  private startEviction(): void {
    const idleMs = this.options.idleMs ?? DSH_SESSION_IDLE_MS;
    if (idleMs <= 0 || this.evictTimer) return;
    this.evictTimer = setInterval(() => {
      const cutoff = Date.now() - idleMs;
      for (const [key, usedAt] of this.lastUsed) {
        if (usedAt > cutoff || this.active.has(key)) continue;
        this.sessions.delete(key);
        this.lastUsed.delete(key);
        this.queues.delete(key);
        logger.info('[dsh] session evicted after idle timeout', { key });
      }
      if (this.sessions.size === 0 && this.evictTimer) {
        clearInterval(this.evictTimer);
        this.evictTimer = null;
      }
    }, Math.min(60_000, idleMs));
    this.evictTimer.unref();
  }

  private async ensureSession(key: string, sessionId: string, resume: boolean): Promise<HarnessSession> {
    const cached = this.sessions.get(key);
    if (cached) return cached;
    const runtime = this.getHarness();
    let session: HarnessSession | null = null;
    if (resume) {
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 2 && !session; attempt += 1) {
        try {
          session = await runtime.resumeSession(sessionId);
        } catch (error) {
          lastError = error;
          // A previous runtime may still hold the write handle during a restart.
          if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }
      if (!session) {
        logger.warn('[dsh] resume failed; starting a fresh session', {
          key,
          message: lastError instanceof Error ? lastError.message : String(lastError),
        });
      }
    }
    session ??= runtime.session(sessionId);
    this.sessions.set(key, session);
    return session;
  }

  private enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.queues.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }

  async run(
    key: string,
    sessionId: string,
    input: SessionInput,
    onEvent: (event: DshNotificationEvent) => void,
    options: RunOptions = {},
  ): Promise<RunResult> {
    if (this.closed) throw new Error('dsh runtime is closed');
    return this.enqueue(key, async () => {
      this.active.add(key);
      try {
        const session = await this.ensureSession(key, sessionId, options.resume === true);
        const map = createNotificationMapper();
        return await session.run(input, {
          onNotification: (notification) => {
            for (const event of map(notification)) onEvent(event);
          },
        });
      } finally {
        this.active.delete(key);
        this.lastUsed.set(key, Date.now());
        this.startEviction();
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const current = this.harness;
    this.harness = null;
    this.sessions.clear();
    this.queues.clear();
    this.active.clear();
    this.lastUsed.clear();
    if (this.evictTimer) {
      clearInterval(this.evictTimer);
      this.evictTimer = null;
    }
    if (current) {
      await current.close().catch((error) => {
        logger.warn('[dsh] close failed', { message: error instanceof Error ? error.message : String(error) });
      });
    }
  }
}

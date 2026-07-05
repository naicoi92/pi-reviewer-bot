/**
 * Concurrency + rate limiter.
 *
 * Prevents OOM / Z.ai throttling when many projects push MRs at once.
 *
 * - Global concurrency cap (default 3 — GLM-5.2 reviews are CPU-light but
 *   each holds a repo clone + subprocess)
 * - Per-project rate cap (default 1 review / 10s — prevents infinite loop
 *   when a project has a misbehaving webhook)
 */

const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_REVIEWS ?? 3);
const PER_PROJECT_COOLDOWN_MS = Number(
  process.env.PER_PROJECT_COOLDOWN_MS ?? 10_000,
);

/** Simple counting semaphore for global concurrency. */
class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }

  release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  /** For /stats — how many reviews are currently running. */
  get current(): number {
    return this.active;
  }
}

/** Per-project cooldown tracker. */
class ProjectRateLimit {
  private lastStartedAt = new Map<string, number>();

  /**
   * Wait until the project's cooldown has elapsed.
   * Returns the wait duration (0 if no wait needed).
   */
  async waitFor(projectPath: string): Promise<number> {
    const now = Date.now();
    const last = this.lastStartedAt.get(projectPath) ?? 0;
    const elapsed = now - last;
    const waitMs = Math.max(0, PER_PROJECT_COOLDOWN_MS - elapsed);
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    }
    this.lastStartedAt.set(projectPath, Date.now());
    return waitMs;
  }
}

export const globalSemaphore = new Semaphore(MAX_CONCURRENT);
export const projectRateLimit = new ProjectRateLimit();

/**
 * Run a function with both rate + concurrency limits applied.
 * Releases the semaphore even if fn throws.
 */
export async function withLimits<T>(
  projectPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  await projectRateLimit.waitFor(projectPath);
  await globalSemaphore.acquire();
  try {
    return await fn();
  } finally {
    globalSemaphore.release();
  }
}

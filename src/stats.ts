/**
 * In-memory stats collector for multi-project observability.
 *
 * Tracks per-project review outcomes + global aggregates. Persists for the
 * lifetime of the process — when Fly.io restarts the machine, stats reset.
 * For long-term retention, ship to GlitchTip/Prometheus (post-MVP).
 *
 * Concurrency-safe: all mutations go through a single event loop, no locking
 * needed (Bun is single-threaded JS).
 */

export type ReviewOutcome = "approved" | "unapproved" | "skipped" | "error";

interface ProjectStats {
  projectPath: string;
  total: number;
  byOutcome: Record<ReviewOutcome, number>;
  /** Sum of review durations in ms — divide by total for average. */
  totalDurationMs: number;
  lastReviewAt: number | null;
  lastOutcome: ReviewOutcome | null;
  lastMrIid: number | null;
}

interface GlobalStats {
  totalReviews: number;
  totalErrors: number;
  byOutcome: Record<ReviewOutcome, number>;
  startedAt: number;
}

class StatsCollector {
  private projects = new Map<string, ProjectStats>();
  private global: GlobalStats = {
    totalReviews: 0,
    totalErrors: 0,
    byOutcome: { approved: 0, unapproved: 0, skipped: 0, error: 0 },
    startedAt: Date.now(),
  };

  /** Record one review outcome. */
  record(opts: {
    projectPath: string;
    mrIid: number;
    outcome: ReviewOutcome;
    durationMs: number;
  }): void {
    const { projectPath, mrIid, outcome, durationMs } = opts;

    // Project-level
    let p = this.projects.get(projectPath);
    if (!p) {
      p = {
        projectPath,
        total: 0,
        byOutcome: { approved: 0, unapproved: 0, skipped: 0, error: 0 },
        totalDurationMs: 0,
        lastReviewAt: null,
        lastOutcome: null,
        lastMrIid: null,
      };
      this.projects.set(projectPath, p);
    }
    p.total += 1;
    p.byOutcome[outcome] += 1;
    p.totalDurationMs += durationMs;
    p.lastReviewAt = Date.now();
    p.lastOutcome = outcome;
    p.lastMrIid = mrIid;

    // Global
    this.global.totalReviews += 1;
    this.global.byOutcome[outcome] += 1;
    if (outcome === "error") this.global.totalErrors += 1;
  }

  /** Snapshot for /stats endpoint. */
  snapshot(): {
    global: GlobalStats & { uptimeMs: number; projectsTracked: number };
    projects: Array<
      ProjectStats & { avgDurationMs: number; successRate: number }
    >;
  } {
    const uptimeMs = Date.now() - this.global.startedAt;
    const projects = Array.from(this.projects.values())
      .map((p) => ({
        ...p,
        avgDurationMs: p.total > 0 ? Math.round(p.totalDurationMs / p.total) : 0,
        successRate:
          p.total > 0
            ? Math.round((p.byOutcome.approved / p.total) * 1000) / 10
            : 0,
      }))
      .sort((a, b) => (b.lastReviewAt ?? 0) - (a.lastReviewAt ?? 0));

    return {
      global: {
        ...this.global,
        uptimeMs,
        projectsTracked: this.projects.size,
      },
      projects,
    };
  }
}

/** Singleton — imported across the codebase. */
export const stats = new StatsCollector();

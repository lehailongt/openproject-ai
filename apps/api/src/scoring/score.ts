// C01 — Scoring function (finalised draft, mock-first).
// Pure function: no UI, no network, no DB. Same input => same output.
// Rule version: c01-v1. See C01-SPEC.md for the decisions this file locks in.
//
// Formula (docs/scoring-rules.md §7):
//   taskScore   = max(0, difficulty x deadlineFactor - sum(validated bug penalties))
//   personScore = sum(taskScore x contributionShare) over that person's tasks
// Bug penalties: Low 0.5, Medium 1, High 2, Critical 4.
// Difficulty must be one of 1 | 2 | 3 | 5 | 8. No rounding inside this
// module — round only at display / score finalisation (C04).

export type Difficulty = 1 | 2 | 3 | 5 | 8;
export type BugSeverity = 'Low' | 'Medium' | 'High' | 'Critical';

export const RULE_VERSION = 'c01-v1';
export const SCORE_TIMEZONE = 'Asia/Ho_Chi_Minh';

export const BUG_PENALTY: Record<BugSeverity, number> = {
  Low: 0.5,
  Medium: 1,
  High: 2,
  Critical: 4,
};

const VALID_DIFFICULTIES: readonly number[] = [1, 2, 3, 5, 8];

// ---------------------------------------------------------------------------
// Deadline factor — calendar days in Asia/Ho_Chi_Minh (docs-aligned).
// This intentionally supersedes the sample's UTC-midnight + Math.floor
// rule: a due date "YYYY-MM-DD" means that whole calendar day in HCM
// (deadline at 23:59:59 HCM), and acceptedAt is read as its HCM calendar
// date. Demo data gives identical results under both rules; the HCM rule
// only changes edge cases (e.g. accepted early morning HCM on the due
// date => on time 1.00, not early 1.05).
// ---------------------------------------------------------------------------

function hcmDayNumber(value: Date | string): number {
  if (typeof value === 'string') {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (dateOnly) {
      const [, y, m, d] = dateOnly;
      return Date.UTC(Number(y), Number(m) - 1, Number(d)) / 86_400_000;
    }
  }
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SCORE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`Cannot read ${type} from date`);
    return Number(part.value);
  };
  return Date.UTC(get('year'), get('month') - 1, get('day')) / 86_400_000;
}

export function deadlineFactor(acceptedAt: Date | string, dueDate: Date | string): number {
  const diffDays = hcmDayNumber(acceptedAt) - hcmDayNumber(dueDate);
  if (diffDays <= -1) return 1.05;
  if (diffDays === 0) return 1.0;
  if (diffDays <= 2) return 0.9;
  return 0.8;
}

// ---------------------------------------------------------------------------
// Legacy strict API — same shape as the existing sample in
// apps/api/src/scoring/score.ts, so existing callers keep working.
// Throws on invalid input instead of silently scoring 0.
// ---------------------------------------------------------------------------

export interface ScoreInput {
  difficulty: Difficulty;
  acceptedAt: Date;
  dueDate: Date;
  bugs: Array<{ severity: BugSeverity }>;
  contributionShare: number;
}

export function computeTaskScore(input: ScoreInput) {
  if (!VALID_DIFFICULTIES.includes(input.difficulty)) {
    throw new Error(`Invalid difficulty: ${input.difficulty}. Must be one of 1, 2, 3, 5, 8.`);
  }
  if (!(input.contributionShare >= 0 && input.contributionShare <= 1)) {
    throw new Error(`Invalid contributionShare: ${input.contributionShare}. Must be in [0, 1].`);
  }
  const base = input.difficulty;
  const factor = deadlineFactor(input.acceptedAt, input.dueDate);
  const penalty = input.bugs.reduce((sum, b) => {
    const p = BUG_PENALTY[b.severity];
    if (p === undefined) throw new Error(`Invalid bug severity: ${String(b.severity)}`);
    return sum + p;
  }, 0);
  const taskScore = Math.max(0, base * factor - penalty);
  return {
    taskScore,
    personScore: taskScore * input.contributionShare,
    breakdown: {
      base,
      factor,
      penalty,
      share: input.contributionShare,
      ruleVersion: RULE_VERSION,
    },
  };
}

// ---------------------------------------------------------------------------
// Safe API — the one B's data prep and C02/C04 should call.
// Missing data is NEVER scored as 0: it returns ok:false with a reason,
// so the UI can show "insufficient data" instead of a misleading zero.
// Rules enforced here (from docs/scoring-rules.md):
//  - only execution units (Task without Subtasks, or leaf Subtasks) score;
//  - only DONE tasks with an accepted date score; reopened tasks must be
//    de-duplicated by the caller (one score per workPackageId per period);
//  - only validated bugs count (validated === false is excluded; a bug
//    without a validated flag is treated as validated ONLY by the legacy
//    API — here it must be passed explicitly by B's data prep);
//  - a Subtask's accepted date must already be replaced by its parent
//    task's acceptance date by the caller (see C01-SPEC.md §4).
// ---------------------------------------------------------------------------

export interface ContributionInput {
  userId: number;
  share: number;
}

export interface TaskScoreInput {
  workPackageId: number;
  isExecutionUnit: boolean;
  status: string;
  difficulty: number | null;
  baselineDueDate: string | null;
  acceptedAt: string | null;
  contributions: ContributionInput[];
  bugs: Array<{ severity: BugSeverity; validated: boolean }>;
}

export type InsufficientReason =
  | 'not-execution-unit'
  | 'not-done'
  | 'missing-difficulty'
  | 'invalid-difficulty'
  | 'missing-due-date'
  | 'missing-accepted-at'
  | 'invalid-contribution-shares';

export type ScoreTaskResult =
  | {
      ok: true;
      workPackageId: number;
      taskScore: number;
      allocations: Array<{ userId: number; score: number }>;
      breakdown: {
        base: number;
        factor: number;
        penalty: number;
        diffDays: number;
        ruleVersion: string;
      };
    }
  | { ok: false; workPackageId: number; reason: InsufficientReason };

export function scoreTask(input: TaskScoreInput): ScoreTaskResult {
  const { workPackageId } = input;
  if (!input.isExecutionUnit) return { ok: false, workPackageId, reason: 'not-execution-unit' };
  if (input.status !== 'DONE') return { ok: false, workPackageId, reason: 'not-done' };
  if (input.difficulty === null || input.difficulty === undefined) {
    return { ok: false, workPackageId, reason: 'missing-difficulty' };
  }
  if (!VALID_DIFFICULTIES.includes(input.difficulty)) {
    return { ok: false, workPackageId, reason: 'invalid-difficulty' };
  }
  if (!input.baselineDueDate) return { ok: false, workPackageId, reason: 'missing-due-date' };
  if (!input.acceptedAt) return { ok: false, workPackageId, reason: 'missing-accepted-at' };
  const shareSum = input.contributions.reduce((s, c) => s + c.share, 0);
  const sharesValid =
    input.contributions.length > 0 &&
    input.contributions.every((c) => c.share >= 0 && c.share <= 1) &&
    shareSum > 0 &&
    shareSum <= 1 + 1e-9;
  if (!sharesValid) return { ok: false, workPackageId, reason: 'invalid-contribution-shares' };

  const factor = deadlineFactor(input.acceptedAt, input.baselineDueDate);
  const diffDays = hcmDayNumber(input.acceptedAt) - hcmDayNumber(input.baselineDueDate);
  const penalty = input.bugs
    .filter((b) => b.validated)
    .reduce((sum, b) => sum + BUG_PENALTY[b.severity], 0);
  const taskScore = Math.max(0, input.difficulty * factor - penalty);
  return {
    ok: true,
    workPackageId,
    taskScore,
    allocations: input.contributions.map((c) => ({
      userId: c.userId,
      score: taskScore * c.share,
    })),
    breakdown: {
      base: input.difficulty,
      factor,
      penalty,
      diffDays,
      ruleVersion: RULE_VERSION,
    },
  };
}

export interface PersonScore {
  userId: number;
  score: number;
  taskCount: number;
}

export function aggregatePersonScores(results: ScoreTaskResult[]): PersonScore[] {
  const byUser = new Map<number, PersonScore>();
  for (const r of results) {
    if (!r.ok) continue;
    for (const a of r.allocations) {
      const cur = byUser.get(a.userId) ?? { userId: a.userId, score: 0, taskCount: 0 };
      cur.score += a.score;
      cur.taskCount += 1;
      byUser.set(a.userId, cur);
    }
  }
  return [...byUser.values()].sort((a, b) => a.userId - b.userId);
}

// ---------------------------------------------------------------------------
// C02 — Score runs: one score per workPackageId per period.
// This is the layer C04 will call with a whole period's tasks, and the
// layer C02 tests. It is additive: it only composes scoreTask() and
// aggregatePersonScores(), it changes no C01 rule.
// Rules:
//  - REOPEN / DUPLICATES: tasks are de-duplicated by workPackageId and
//    the LAST occurrence wins. The caller (B's data prep / C04) must pass
//    tasks in chronological order, so "last" means "latest state". A task
//    that was DONE, reopened, and DONE again therefore counts exactly
//    once, with its latest DONE state; a task still open at period end
//    (last state not DONE) is skipped with reason 'not-done', not scored.
//  - MISSING DATA AT RUN LEVEL: a task that scoreTask() rejects is listed
//    in `skipped` with its exact reason and contributes nothing — never a
//    silent 0. `incomplete` is true iff at least one task was skipped, so
//    the UI can show "kỳ chưa đủ dữ liệu" instead of a misleading total.
//  - REPRODUCIBILITY: same task list => same totals, scored list and
//    skipped list. `ruleVersion` and `asOf` are recorded metadata only:
//    this function always computes with the c01-v1 rules above; a rule
//    change needs a new function version, not a different label.
//  - An empty period is NOT incomplete: totals [], totalScore 0, and
//    incomplete false (nothing was missing, there was simply nothing).
// ---------------------------------------------------------------------------

export interface ScoreRunInput {
  tasks: TaskScoreInput[];
  /** Defaults to RULE_VERSION ('c01-v1'). Metadata only, see above. */
  ruleVersion?: string;
  /** Period snapshot time, e.g. an ISO timestamp. Metadata only. */
  asOf?: string | null;
  projectId?: number | null;
}

export interface SkippedTask {
  workPackageId: number;
  reason: InsufficientReason;
}

export interface ScoredTask {
  workPackageId: number;
  taskScore: number;
}

export interface ScoreRunResult {
  ruleVersion: string;
  asOf: string | null;
  projectId: number | null;
  totals: PersonScore[];
  scored: ScoredTask[];
  skipped: SkippedTask[];
  scoredTaskCount: number;
  skippedTaskCount: number;
  incomplete: boolean;
  totalScore: number;
}

export function scoreRun(input: ScoreRunInput): ScoreRunResult {
  const deduped = new Map<number, TaskScoreInput>();
  for (const task of input.tasks) deduped.set(task.workPackageId, task);
  const results = [...deduped.values()].map((task) => scoreTask(task));

  const scored: ScoredTask[] = [];
  const skipped: SkippedTask[] = [];
  for (const r of results) {
    if (r.ok) scored.push({ workPackageId: r.workPackageId, taskScore: r.taskScore });
    else skipped.push({ workPackageId: r.workPackageId, reason: r.reason });
  }
  const totals = aggregatePersonScores(results);
  return {
    ruleVersion: input.ruleVersion ?? RULE_VERSION,
    asOf: input.asOf ?? null,
    projectId: input.projectId ?? null,
    totals,
    scored,
    skipped,
    scoredTaskCount: scored.length,
    skippedTaskCount: skipped.length,
    incomplete: skipped.length > 0,
    totalScore: scored.reduce((sum, s) => sum + s.taskScore, 0),
  };
}

// C02 tests — score runs: reopen, missing data at run level, reproducibility.
// Run from apps/api with the repo's existing tsx:
//   npx tsx --test tests/scoring/score-runs.test.ts
// No test runner dependency is added: node:test + node:assert only.
// These tests sit on top of C01: scoreTask() rules are NOT re-tested here
// except where a run composes them (totals, skipped lists, dedupe).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RULE_VERSION,
  scoreRun,
  type TaskScoreInput,
} from '../../src/scoring/score.js';

const approx = (actual: number, expected: number, msg: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg}: expected ${expected}, got ${actual}`);

const done = (
  workPackageId: number,
  difficulty: number | null,
  baselineDueDate: string | null,
  acceptedAt: string | null,
  contributions: Array<{ userId: number; share: number }>,
  bugs: Array<{ severity: 'Low' | 'Medium' | 'High' | 'Critical'; validated: boolean }> = [],
  status = 'DONE',
  isExecutionUnit = true,
): TaskScoreInput => ({
  workPackageId,
  isExecutionUnit,
  status,
  difficulty,
  baselineDueDate,
  acceptedAt,
  contributions,
  bugs,
});

// Demo period, mirroring samples/demo-data.json (same 6 tasks as C01).
const demoTasks: TaskScoreInput[] = [
  done(101, 5, '2026-10-08', '2026-10-08T10:00:00Z', [{ userId: 1, share: 1 }], [{ severity: 'Medium', validated: true }]),
  done(102, 3, '2026-10-07', '2026-10-09T10:00:00Z', [{ userId: 1, share: 1 }], [{ severity: 'Low', validated: true }]),
  done(103, 8, '2026-10-08', '2026-10-08T10:00:00Z', [{ userId: 2, share: 1 }], [{ severity: 'Critical', validated: true }]),
  done(104, 2, '2026-10-08', '2026-10-07T10:00:00Z', [{ userId: 2, share: 1 }]),
  done(105, 3, '2026-10-08', '2026-10-08T10:00:00Z', [{ userId: 3, share: 1 }]),
  done(106, 1, '2026-10-05', '2026-10-09T10:00:00Z', [{ userId: 3, share: 1 }], [{ severity: 'Medium', validated: true }]),
];

describe('C02 score runs — reopen is counted exactly once', () => {
  it('identical duplicate of a task counts once, not twice', () => {
    const task = done(101, 5, '2026-10-08', '2026-10-08T10:00:00Z', [{ userId: 1, share: 1 }], [{ severity: 'Medium', validated: true }]);
    const run = scoreRun({ tasks: [task, task] });
    assert.equal(run.scoredTaskCount, 1);
    assert.deepEqual(run.totals, [{ userId: 1, score: 4, taskCount: 1 }]);
    approx(run.totalScore, 4, 'totalScore');
    assert.equal(run.incomplete, false);
  });

  it('DONE, reopened, then DONE again counts once with the latest DONE state', () => {
    // First DONE on time: 5 x 1.00 - 1 = 4.00. Reopened and DONE again
    // late (>= 3 days, due 08/10, accepted 11/10): 5 x 0.80 - 1 = 3.00.
    // Input order is chronological, so the last occurrence wins.
    const first = done(101, 5, '2026-10-08', '2026-10-08T10:00:00Z', [{ userId: 1, share: 1 }], [{ severity: 'Medium', validated: true }]);
    const latest = done(101, 5, '2026-10-08', '2026-10-11T10:00:00Z', [{ userId: 1, share: 1 }], [{ severity: 'Medium', validated: true }]);
    const run = scoreRun({ tasks: [first, latest] });
    assert.equal(run.scoredTaskCount, 1);
    assert.deepEqual(run.scored, [{ workPackageId: 101, taskScore: 3 }]);
    approx(run.totalScore, 3, 'totalScore uses latest state only');
  });

  it('DONE then reopened and still open at period end is skipped, not scored', () => {
    const first = done(101, 5, '2026-10-08', '2026-10-08T10:00:00Z', [{ userId: 1, share: 1 }], [{ severity: 'Medium', validated: true }]);
    const reopened = done(101, 5, '2026-10-08', null, [{ userId: 1, share: 1 }], [], 'IN PROGRESS');
    const run = scoreRun({ tasks: [first, reopened] });
    assert.equal(run.scoredTaskCount, 0);
    assert.deepEqual(run.skipped, [{ workPackageId: 101, reason: 'not-done' }]);
    assert.deepEqual(run.totals, []);
    assert.equal(run.incomplete, true);
  });

  it('duplicate of a shared task splits its score once, not once per copy', () => {
    // Score 5 task shared 0.6 / 0.4 => 3.0 + 2.0, even if listed twice.
    const task = done(201, 5, '2026-10-08', '2026-10-08T10:00:00Z', [{ userId: 1, share: 0.6 }, { userId: 2, share: 0.4 }]);
    const run = scoreRun({ tasks: [task, task] });
    assert.deepEqual(run.totals, [
      { userId: 1, score: 3, taskCount: 1 },
      { userId: 2, score: 2, taskCount: 1 },
    ]);
  });
});

describe('C02 score runs — missing data is reported, never silently zero', () => {
  it('good task scores, missing/invalid tasks are skipped with exact reasons', () => {
    const good = done(101, 5, '2026-10-08', '2026-10-08T10:00:00Z', [{ userId: 1, share: 1 }], [{ severity: 'Medium', validated: true }]);
    const missingDue = done(102, 3, null, '2026-10-09T10:00:00Z', [{ userId: 1, share: 1 }]);
    const invalidDifficulty = done(103, 4, '2026-10-08', '2026-10-08T10:00:00Z', [{ userId: 2, share: 1 }]);
    const run = scoreRun({ tasks: [good, missingDue, invalidDifficulty] });
    assert.equal(run.scoredTaskCount, 1);
    assert.deepEqual(run.scored, [{ workPackageId: 101, taskScore: 4 }]);
    assert.deepEqual(run.skipped, [
      { workPackageId: 102, reason: 'missing-due-date' },
      { workPackageId: 103, reason: 'invalid-difficulty' },
    ]);
    assert.deepEqual(run.totals, [{ userId: 1, score: 4, taskCount: 1 }]);
    approx(run.totalScore, 4, 'skipped tasks add nothing, but are listed');
    assert.equal(run.incomplete, true);
  });

  it('missing accepted date, bad shares, non-execution-unit and non-DONE are all skipped', () => {
    const run = scoreRun({
      tasks: [
        done(111, 3, '2026-10-08', null, [{ userId: 1, share: 1 }]),
        done(112, 3, '2026-10-08', '2026-10-08T10:00:00Z', []),
        done(113, 3, '2026-10-08', '2026-10-08T10:00:00Z', [{ userId: 1, share: 1 }], [], 'DONE', false),
        done(114, 3, '2026-10-08', '2026-10-08T10:00:00Z', [{ userId: 1, share: 1 }], [], 'REVIEW'),
      ],
    });
    assert.equal(run.scoredTaskCount, 0);
    assert.deepEqual(run.skipped, [
      { workPackageId: 111, reason: 'missing-accepted-at' },
      { workPackageId: 112, reason: 'invalid-contribution-shares' },
      { workPackageId: 113, reason: 'not-execution-unit' },
      { workPackageId: 114, reason: 'not-done' },
    ]);
    assert.equal(run.incomplete, true);
    assert.equal(run.totalScore, 0);
  });

  it('empty period is empty, not incomplete', () => {
    const run = scoreRun({ tasks: [] });
    assert.deepEqual(run.totals, []);
    assert.deepEqual(run.scored, []);
    assert.deepEqual(run.skipped, []);
    assert.equal(run.incomplete, false);
    assert.equal(run.totalScore, 0);
  });

  it('two validated bugs on one task both subtract; an unvalidated bug does not', () => {
    const task = done(202, 5, '2026-10-08', '2026-10-08T10:00:00Z', [{ userId: 1, share: 1 }], [
      { severity: 'Medium', validated: true },
      { severity: 'Low', validated: true },
      { severity: 'Critical', validated: false },
    ]);
    const run = scoreRun({ tasks: [task] });
    // 5 x 1.00 - (1 + 0.5) = 3.50; the unvalidated Critical (4) must not count.
    assert.deepEqual(run.scored, [{ workPackageId: 202, taskScore: 3.5 }]);
  });
});

describe('C02 score runs — totals and reproducibility', () => {
  it('demo period aggregates to A=6.20, B=6.10, C=3.00 with no skips', () => {
    const run = scoreRun({ tasks: demoTasks, asOf: '2026-10-10T08:00:00Z', projectId: 10 });
    assert.deepEqual(run.totals, [
      { userId: 1, score: 6.2, taskCount: 2 },
      { userId: 2, score: 6.1, taskCount: 2 },
      { userId: 3, score: 3, taskCount: 2 },
    ]);
    assert.equal(run.scoredTaskCount, 6);
    assert.equal(run.skippedTaskCount, 0);
    assert.equal(run.incomplete, false);
    assert.equal(run.ruleVersion, RULE_VERSION);
    assert.equal(run.asOf, '2026-10-10T08:00:00Z');
    assert.equal(run.projectId, 10);
  });

  it('sum of person totals always equals totalScore and sum of scored tasks', () => {
    const run = scoreRun({ tasks: demoTasks });
    const sumTotals = run.totals.reduce((s, t) => s + t.score, 0);
    const sumScored = run.scored.reduce((s, t) => s + t.taskScore, 0);
    approx(sumTotals, run.totalScore, 'sum of totals');
    approx(sumScored, run.totalScore, 'sum of scored tasks');
  });

  it('same input run twice gives identical results', () => {
    const run1 = scoreRun({ tasks: demoTasks, asOf: '2026-10-10T08:00:00Z', projectId: 10 });
    const run2 = scoreRun({ tasks: demoTasks, asOf: '2026-10-10T08:00:00Z', projectId: 10 });
    assert.deepEqual(run2, run1);
  });

  it('asOf and ruleVersion are metadata: changing the label changes no score', () => {
    const base = scoreRun({ tasks: demoTasks });
    const labelled = scoreRun({ tasks: demoTasks, asOf: '2026-10-11T08:00:00Z', ruleVersion: 'demo-v1' });
    assert.deepEqual(labelled.totals, base.totals);
    assert.deepEqual(labelled.scored, base.scored);
    assert.deepEqual(labelled.skipped, base.skipped);
    assert.equal(labelled.asOf, '2026-10-11T08:00:00Z');
    assert.equal(labelled.ruleVersion, 'demo-v1');
  });
});

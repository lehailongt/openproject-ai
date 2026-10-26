// C01 tests — run from apps/api with the repo's existing tsx:
//   npx tsx --test tests/scoring/score.test.ts
// No test runner dependency is added: node:test + node:assert only.
// Oracle: samples/demo-data.json (6 tasks, 4 validated bugs).
// Expected period totals: A (user 1) = 6.20, B (user 2) = 6.10, C (user 3) = 3.00.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregatePersonScores,
  computeTaskScore,
  deadlineFactor,
  scoreTask,
  type TaskScoreInput,
} from '../../src/scoring/score.js';

const approx = (actual: number, expected: number, msg: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg}: expected ${expected}, got ${actual}`);

// Demo inputs, mirroring samples/demo-data.json (validated bugs only).
const demoTasks: TaskScoreInput[] = [
  {
    workPackageId: 101, isExecutionUnit: true, status: 'DONE', difficulty: 5,
    baselineDueDate: '2026-10-08', acceptedAt: '2026-10-08T10:00:00Z',
    contributions: [{ userId: 1, share: 1 }],
    bugs: [{ severity: 'Medium', validated: true }],
  },
  {
    workPackageId: 102, isExecutionUnit: true, status: 'DONE', difficulty: 3,
    baselineDueDate: '2026-10-07', acceptedAt: '2026-10-09T10:00:00Z',
    contributions: [{ userId: 1, share: 1 }],
    bugs: [{ severity: 'Low', validated: true }],
  },
  {
    workPackageId: 103, isExecutionUnit: true, status: 'DONE', difficulty: 8,
    baselineDueDate: '2026-10-08', acceptedAt: '2026-10-08T10:00:00Z',
    contributions: [{ userId: 2, share: 1 }],
    bugs: [{ severity: 'Critical', validated: true }],
  },
  {
    workPackageId: 104, isExecutionUnit: true, status: 'DONE', difficulty: 2,
    baselineDueDate: '2026-10-08', acceptedAt: '2026-10-07T10:00:00Z',
    contributions: [{ userId: 2, share: 1 }],
    bugs: [],
  },
  {
    workPackageId: 105, isExecutionUnit: true, status: 'DONE', difficulty: 3,
    baselineDueDate: '2026-10-08', acceptedAt: '2026-10-08T10:00:00Z',
    contributions: [{ userId: 3, share: 1 }],
    bugs: [],
  },
  {
    workPackageId: 106, isExecutionUnit: true, status: 'DONE', difficulty: 1,
    baselineDueDate: '2026-10-05', acceptedAt: '2026-10-09T10:00:00Z',
    contributions: [{ userId: 3, share: 1 }],
    bugs: [{ severity: 'Medium', validated: true }],
  },
];

describe('C01 demo oracle (samples/demo-data.json)', () => {
  it('scores each demo task exactly', () => {
    const expected = [4.0, 2.2, 4.0, 2.1, 3.0, 0.0];
    demoTasks.forEach((t, i) => {
      const r = scoreTask(t);
      assert.equal(r.ok, true, `task ${t.workPackageId} should score`);
      if (r.ok) approx(r.taskScore, expected[i], `task ${t.workPackageId}`);
    });
  });

  it('aggregates the period to A=6.20, B=6.10, C=3.00', () => {
    const people = aggregatePersonScores(demoTasks.map(scoreTask));
    approx(people.find((p) => p.userId === 1)!.score, 6.2, 'A');
    approx(people.find((p) => p.userId === 2)!.score, 6.1, 'B');
    approx(people.find((p) => p.userId === 3)!.score, 3.0, 'C');
    assert.deepEqual(people.map((p) => p.taskCount), [2, 2, 2]);
  });

  it('floors task 106 at 0 instead of going negative (1 x 0.8 - 1 = -0.2)', () => {
    const r = scoreTask(demoTasks[5]);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.taskScore, 0);
  });

  it('legacy computeTaskScore still matches the demo for task 101', () => {
    const r = computeTaskScore({
      difficulty: 5,
      acceptedAt: new Date('2026-10-08T10:00:00Z'),
      dueDate: new Date('2026-10-08'),
      bugs: [{ severity: 'Medium' }],
      contributionShare: 1,
    });
    assert.equal(r.taskScore, 4.0);
    assert.equal(r.personScore, 4.0);
  });
});

describe('deadline factor — HCM calendar days (C01 decision)', () => {
  it('early >= 1 day => 1.05, on due date => 1.00', () => {
    assert.equal(deadlineFactor('2026-10-07T10:00:00Z', '2026-10-08'), 1.05);
    assert.equal(deadlineFactor('2026-10-08T10:00:00Z', '2026-10-08'), 1.0);
  });

  it('accepted early morning HCM on the due date counts as on time, not early', () => {
    // 02:00+07 on 2026-10-08 is 19:00Z on 2026-10-07. The old UTC-midnight
    // rule scored this 1.05; the docs-aligned HCM rule scores 1.00.
    assert.equal(deadlineFactor('2026-10-08T02:00:00+07:00', '2026-10-08'), 1.0);
  });

  it('late 1-2 days => 0.90, late >= 3 days => 0.80', () => {
    assert.equal(deadlineFactor('2026-10-09T10:00:00Z', '2026-10-08'), 0.9);
    assert.equal(deadlineFactor('2026-10-10T10:00:00Z', '2026-10-08'), 0.9);
    assert.equal(deadlineFactor('2026-10-11T10:00:00Z', '2026-10-08'), 0.8);
  });

  it('bug penalties: Low 0.5, Medium 1, High 2, Critical 4', () => {
    const base: TaskScoreInput = {
      workPackageId: 900, isExecutionUnit: true, status: 'DONE', difficulty: 8,
      baselineDueDate: '2026-10-08', acceptedAt: '2026-10-08T10:00:00Z',
      contributions: [{ userId: 1, share: 1 }], bugs: [],
    };
    const cases: Array<[TaskScoreInput['bugs'][number]['severity'], number]> = [
      ['Low', 7.5], ['Medium', 7], ['High', 6], ['Critical', 4],
    ];
    for (const [severity, expected] of cases) {
      const r = scoreTask({ ...base, bugs: [{ severity, validated: true }] });
      assert.equal(r.ok, true);
      if (r.ok) assert.equal(r.taskScore, expected);
    }
  });
});

describe('missing / invalid data is never silently scored as 0', () => {
  const base: TaskScoreInput = {
    workPackageId: 901, isExecutionUnit: true, status: 'DONE', difficulty: 3,
    baselineDueDate: '2026-10-08', acceptedAt: '2026-10-08T10:00:00Z',
    contributions: [{ userId: 1, share: 1 }], bugs: [],
  };
  it('missing due date / accepted date / difficulty => ok:false', () => {
    assert.deepEqual(scoreTask({ ...base, baselineDueDate: null }).ok, false);
    assert.deepEqual(scoreTask({ ...base, acceptedAt: null }).ok, false);
    assert.deepEqual(scoreTask({ ...base, difficulty: null }).ok, false);
    const noDue = scoreTask({ ...base, baselineDueDate: null });
    if (!noDue.ok) assert.equal(noDue.reason, 'missing-due-date');
  });

  it('invalid difficulty 4 and non-execution / non-DONE tasks => ok:false', () => {
    const bad = scoreTask({ ...base, difficulty: 4 });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.reason, 'invalid-difficulty');
    assert.equal(scoreTask({ ...base, isExecutionUnit: false }).ok, false);
    assert.equal(scoreTask({ ...base, status: 'IN PROGRESS' }).ok, false);
  });

  it('unvalidated bugs do not subtract; validated bugs do', () => {
    const unvalidated = scoreTask({
      ...base, bugs: [{ severity: 'Critical', validated: false }],
    });
    assert.equal(unvalidated.ok, true);
    if (unvalidated.ok) assert.equal(unvalidated.taskScore, 3.0);
    const validated = scoreTask({
      ...base, bugs: [{ severity: 'Critical', validated: true }],
    });
    if (validated.ok) assert.equal(validated.taskScore, 0);
  });

  it('contribution shares split a task score across people', () => {
    const r = scoreTask({
      ...base, difficulty: 5,
      contributions: [
        { userId: 1, share: 0.6 },
        { userId: 2, share: 0.4 },
      ],
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual(r.allocations, [
        { userId: 1, score: 3 },
        { userId: 2, score: 2 },
      ]);
    }
  });
});

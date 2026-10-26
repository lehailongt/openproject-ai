// export interface TaskSnapshot {
//   id: number;
//   type: string;
//   isExecutionUnit: boolean;
//   ownerAtBaselineId: number | null;
//   acceptedAt: string | null;
//   dueDate: string | null;
//   status: string;
// }

// export function countCompletedTasks(tasks: TaskSnapshot[]): number {
//   return tasks.filter(t =>
//     t.isExecutionUnit &&
//     t.status === 'DONE' &&
//     t.acceptedAt !== null
//   ).length;
// }

// export function countDefects(
//   defects: Array<{ sourceTaskId: number; isDuplicate: boolean; isNotABug: boolean }>
// ): number {
//   return defects.filter(d => !d.isDuplicate && !d.isNotABug).length;
// }

// export function defectRate(totalDefects: number, taskCount: number): number | null {
//   if (taskCount === 0) return null;
//   return totalDefects / taskCount;
// }


export type TimeEvidence =
  | "confirmed"
  | "confirmed-demo"
  | "history"
  | "polling-estimate"
  | "missing";

export interface Contribution {
  personId: number;
  share: number;
}

export interface TaskSnapshot {
  id: number;
  projectId?: number;
  type: string;
  parentId?: number | null;
  isExecutionUnit: boolean;

  ownerAtBaselineId: number | null;
  currentAssigneeId?: number | null;

  status: string;
  completedAt?: string | null;
  acceptedAt: string | null;
  acceptedBy?: number | null;
  acceptanceEventId?: string | null;

  dueDate: string | null;
  baselineDifficulty?: number | null;
  baselineVersion?: number | null;
  timeEvidence?: TimeEvidence;

  contributions?: Contribution[];
}

export interface DefectSnapshot {
  id: number;
  sourceTaskId: number | null;
  severity: "Low" | "Medium" | "High" | "Critical";
  validatedAt: string | null;
  isDuplicate: boolean;
  isNotABug: boolean;
  approvedBy?: number | null;
}

export interface ReportPeriod {
  projectId: number;
  from: string;
  toExclusive: string;
  asOf: string;
  timezone: string;
  ruleVersion: string;
}

export interface ReportDataset {
  report: ReportPeriod;
  tasks: TaskSnapshot[];
  defects: DefectSnapshot[];
}

export interface DataQualityIssue {
  entityType: "task" | "defect" | "report";
  entityId: number | null;
  code: string;
  message: string;
}

export interface PersonReport {
  personId: number;
  completedTasks: number;
  completionShare: number | null;
  onTimeTasks: number;
  tasksWithValidDueDate: number;
  onTimeRate: number | null;
  bugs: number;
  tasksWithBugs: number;
  bugsPerTask: number | null;
  tasksWithBugsRate: number | null;
}

function parseDate(value: string | null | undefined): number | null {
  if (!value) return null;

  const timestamp = Date.parse(value);

  return Number.isFinite(timestamp) ? timestamp : null;
}

function isInPeriod(
  value: string | null | undefined,
  period: ReportPeriod,
): boolean {
  const timestamp = parseDate(value);
  const from = parseDate(period.from);
  const toExclusive = parseDate(period.toExclusive);
  const asOf = parseDate(period.asOf);

  if (
    timestamp === null ||
    from === null ||
    toExclusive === null ||
    asOf === null
  ) {
    return false;
  }

  return timestamp >= from && timestamp < toExclusive && timestamp <= asOf;
}

function isValidatedByAsOf(
  defect: DefectSnapshot,
  period: ReportPeriod,
): boolean {
  const validatedAt = parseDate(defect.validatedAt);
  const asOf = parseDate(period.asOf);

  return (
    validatedAt !== null &&
    asOf !== null &&
    validatedAt <= asOf
  );
}

function hasReliableAcceptance(task: TaskSnapshot): boolean {
  return (
    task.status.toUpperCase() === "DONE" &&
    task.acceptedAt !== null &&
    parseDate(task.acceptedAt) !== null &&
    typeof task.acceptanceEventId === "string" &&
    task.acceptanceEventId.trim().length > 0 &&
    task.timeEvidence !== undefined &&
    task.timeEvidence !== "missing" &&
    task.timeEvidence !== "polling-estimate"
  );
}

function isValidExecutionUnit(task: TaskSnapshot): boolean {
  return (
    task.isExecutionUnit &&
    ["TASK", "SUBTASK"].includes(task.type.toUpperCase())
  );
}

function isValidDefect(defect: DefectSnapshot): boolean {
  return !defect.isDuplicate && !defect.isNotABug;
}

/**
 * Returns defects that are valid, linked to a task,
 * and validated no later than the report's asOf time.
 */
export function getValidDefects(
  defects: DefectSnapshot[],
  period: ReportPeriod,
): DefectSnapshot[] {
  return defects.filter(
    (defect) =>
      isValidDefect(defect) &&
      defect.sourceTaskId !== null &&
      isValidatedByAsOf(defect, period),
  );
}

/**
 * Count execution units accepted during the reporting period.
 *
 * A task is not counted as completed when its acceptance evidence
 * is missing or is based only on polling estimates.
 */
export function countCompletedTasks(
  tasks: TaskSnapshot[],
  period: ReportPeriod,
): number {
  return tasks.filter(
    (task) =>
      isValidExecutionUnit(task) &&
      hasReliableAcceptance(task) &&
      isInPeriod(task.acceptedAt, period),
  ).length;
}

export function countDefects(
  defects: DefectSnapshot[],
  period: ReportPeriod,
): number {
  return getValidDefects(defects, period).length;
}

export function defectRate(
  totalDefects: number,
  taskCount: number,
): number | null {
  if (taskCount <= 0) return null;

  return totalDefects / taskCount;
}

function getTaskContributors(task: TaskSnapshot): Contribution[] {
  if (task.contributions && task.contributions.length > 0) {
    return task.contributions;
  }

  if (task.ownerAtBaselineId === null) {
    return [];
  }

  return [{ personId: task.ownerAtBaselineId, share: 1 }];
}

function getAcceptedExecutionUnits(
  tasks: TaskSnapshot[],
  period: ReportPeriod,
): TaskSnapshot[] {
  return tasks.filter(
    (task) =>
      isValidExecutionUnit(task) &&
      hasReliableAcceptance(task) &&
      isInPeriod(task.acceptedAt, period),
  );
}

function getDefectsByTask(
  defects: DefectSnapshot[],
  period: ReportPeriod,
): Map<number, DefectSnapshot[]> {
  const result = new Map<number, DefectSnapshot[]>();

  for (const defect of getValidDefects(defects, period)) {
    if (defect.sourceTaskId === null) continue;

    const current = result.get(defect.sourceTaskId) ?? [];
    current.push(defect);
    result.set(defect.sourceTaskId, current);
  }

  return result;
}

/**
 * Build per-person statistics.
 *
 * Attribution uses contribution shares when supplied.
 * Otherwise, the baseline owner receives the task.
 *
 * A task can contribute fractionally to multiple people.
 */
export function buildPeopleReport(dataset: ReportDataset): PersonReport[] {
  const { tasks, defects, report: period } = dataset;

  const acceptedTasks = getAcceptedExecutionUnits(tasks, period);
  const defectsByTask = getDefectsByTask(defects, period);

  const totalCompletedTasks = acceptedTasks.length;
  const people = new Map<number, PersonReport>();

  function getPerson(personId: number): PersonReport {
    let person = people.get(personId);

    if (!person) {
      person = {
        personId,
        completedTasks: 0,
        completionShare: null,
        onTimeTasks: 0,
        tasksWithValidDueDate: 0,
        onTimeRate: null,
        bugs: 0,
        tasksWithBugs: 0,
        bugsPerTask: null,
        tasksWithBugsRate: null,
      };

      people.set(personId, person);
    }

    return person;
  }

  for (const task of acceptedTasks) {
    const contributors = getTaskContributors(task);
    const taskDefects = defectsByTask.get(task.id) ?? [];

    const acceptedAt = parseDate(task.acceptedAt);
    const dueDate = parseDate(task.dueDate);

    const hasValidDueDate = dueDate !== null;
    const isOnTime =
      acceptedAt !== null &&
      dueDate !== null &&
      acceptedAt <= dueDate;

    const validShares = contributors.filter(
      (contribution) =>
        Number.isInteger(contribution.personId) &&
        Number.isFinite(contribution.share) &&
        contribution.share > 0 &&
        contribution.share <= 1,
    );

    for (const contribution of validShares) {
      const person = getPerson(contribution.personId);
      const share = contribution.share;

      person.completedTasks += share;

      if (hasValidDueDate) {
        person.tasksWithValidDueDate += share;

        if (isOnTime) {
          person.onTimeTasks += share;
        }
      }

      if (taskDefects.length > 0) {
        person.tasksWithBugs += share;
      }

      person.bugs += taskDefects.length * share;
    }
  }

  for (const person of people.values()) {
    person.completionShare =
      totalCompletedTasks > 0
        ? person.completedTasks / totalCompletedTasks
        : null;

    person.onTimeRate =
      person.tasksWithValidDueDate > 0
        ? person.onTimeTasks / person.tasksWithValidDueDate
        : null;

    person.bugsPerTask =
      person.completedTasks > 0
        ? person.bugs / person.completedTasks
        : null;

    person.tasksWithBugsRate =
      person.completedTasks > 0
        ? person.tasksWithBugs / person.completedTasks
        : null;
  }

  return [...people.values()].sort(
    (a, b) => a.personId - b.personId,
  );
}

export function buildDefectsReport(dataset: ReportDataset) {
  const { tasks, defects, report: period } = dataset;

  const acceptedTasks = getAcceptedExecutionUnits(tasks, period);
  const validDefects = getValidDefects(defects, period);

  const acceptedTaskIds = new Set(
    acceptedTasks.map((task) => task.id),
  );

  const tasksWithBugs = new Set<number>();

  for (const defect of validDefects) {
    if (
      defect.sourceTaskId !== null &&
      acceptedTaskIds.has(defect.sourceTaskId)
    ) {
      tasksWithBugs.add(defect.sourceTaskId);
    }
  }

  const bugsLinkedToAcceptedTasks = validDefects.filter(
    (defect) =>
      defect.sourceTaskId !== null &&
      acceptedTaskIds.has(defect.sourceTaskId),
  );

  const acceptedTaskCount = acceptedTasks.length;
  const bugCount = bugsLinkedToAcceptedTasks.length;

  return {
    projectId: period.projectId,
    period: {
      from: period.from,
      toExclusive: period.toExclusive,
      asOf: period.asOf,
      timezone: period.timezone,
      ruleVersion: period.ruleVersion,
    },
    completedTasks: acceptedTaskCount,
    validBugs: validDefects.length,
    bugsLinkedToAcceptedTasks: bugCount,
    tasksWithBugs: tasksWithBugs.size,
    bugsPerTask: defectRate(bugCount, acceptedTaskCount),
    tasksWithBugsRate: defectRate(
      tasksWithBugs.size,
      acceptedTaskCount,
    ),
    bugsBySeverity: {
      Low: bugsLinkedToAcceptedTasks.filter(
        (bug) => bug.severity === "Low",
      ).length,
      Medium: bugsLinkedToAcceptedTasks.filter(
        (bug) => bug.severity === "Medium",
      ).length,
      High: bugsLinkedToAcceptedTasks.filter(
        (bug) => bug.severity === "High",
      ).length,
      Critical: bugsLinkedToAcceptedTasks.filter(
        (bug) => bug.severity === "Critical",
      ).length,
    },
  };
}

export function validateReportDataset(
  dataset: ReportDataset,
): DataQualityIssue[] {
  const issues: DataQualityIssue[] = [];
  const { report, tasks, defects } = dataset;

  const from = parseDate(report.from);
  const toExclusive = parseDate(report.toExclusive);
  const asOf = parseDate(report.asOf);

  if (from === null || toExclusive === null || asOf === null) {
    issues.push({
      entityType: "report",
      entityId: null,
      code: "INVALID_REPORT_DATES",
      message: "from, toExclusive và asOf phải là ngày giờ hợp lệ.",
    });
  } else {
    if (from >= toExclusive) {
      issues.push({
        entityType: "report",
        entityId: null,
        code: "INVALID_PERIOD",
        message: "from phải nhỏ hơn toExclusive.",
      });
    }

    if (asOf < from) {
      issues.push({
        entityType: "report",
        entityId: null,
        code: "AS_OF_BEFORE_PERIOD",
        message: "asOf nằm trước thời điểm bắt đầu kỳ báo cáo.",
      });
    }
  }

  const taskIds = new Set<number>();

  for (const task of tasks) {
    if (taskIds.has(task.id)) {
      issues.push({
        entityType: "task",
        entityId: task.id,
        code: "DUPLICATE_TASK_ID",
        message: `Task ${task.id} xuất hiện nhiều lần.`,
      });
    }

    taskIds.add(task.id);

    if (!isValidExecutionUnit(task)) continue;

    if (task.status.toUpperCase() === "DONE" && !task.acceptedAt) {
      issues.push({
        entityType: "task",
        entityId: task.id,
        code: "MISSING_ACCEPTANCE_TIME",
        message: "Task DONE nhưng thiếu acceptedAt.",
      });
    }

    if (task.acceptedAt && parseDate(task.acceptedAt) === null) {
      issues.push({
        entityType: "task",
        entityId: task.id,
        code: "INVALID_ACCEPTANCE_TIME",
        message: "acceptedAt không phải ngày giờ hợp lệ.",
      });
    }

    if (
      task.status.toUpperCase() === "DONE" &&
      !task.acceptanceEventId
    ) {
      issues.push({
        entityType: "task",
        entityId: task.id,
        code: "MISSING_ACCEPTANCE_EVENT",
        message:
          "Task DONE thiếu acceptanceEventId; cần xác minh bằng chứng nghiệm thu.",
      });
    }

    if (
      task.status.toUpperCase() === "DONE" &&
      (!task.timeEvidence ||
        task.timeEvidence === "missing" ||
        task.timeEvidence === "polling-estimate")
    ) {
      issues.push({
        entityType: "task",
        entityId: task.id,
        code: "UNRELIABLE_ACCEPTANCE_EVIDENCE",
        message:
          "Task DONE chưa có bằng chứng nghiệm thu đủ tin cậy để tính báo cáo.",
      });
    }

    if (task.ownerAtBaselineId === null) {
      issues.push({
        entityType: "task",
        entityId: task.id,
        code: "MISSING_BASELINE_OWNER",
        message: "Task thiếu người phụ trách tại thời điểm baseline.",
      });
    }

    if (task.baselineVersion === null || task.baselineVersion === undefined) {
      issues.push({
        entityType: "task",
        entityId: task.id,
        code: "MISSING_BASELINE_VERSION",
        message: "Task thiếu baselineVersion.",
      });
    }

    const contributions = getTaskContributors(task);

    if (contributions.length > 0) {
      const validContributions = contributions.every(
        (contribution) =>
          Number.isInteger(contribution.personId) &&
          Number.isFinite(contribution.share) &&
          contribution.share > 0 &&
          contribution.share <= 1,
      );

      const shareTotal = contributions.reduce(
        (sum, contribution) => sum + contribution.share,
        0,
      );

      if (!validContributions || Math.abs(shareTotal - 1) > 0.000001) {
        issues.push({
          entityType: "task",
          entityId: task.id,
          code: "INVALID_CONTRIBUTION_SHARES",
          message:
            "Tổng contribution share phải bằng 1 và mỗi share phải nằm trong (0, 1].",
        });
      }
    }

    if (
      task.type.toUpperCase() === "SUBTASK" &&
      task.parentId === null
    ) {
      issues.push({
        entityType: "task",
        entityId: task.id,
        code: "SUBTASK_MISSING_PARENT",
        message: "Subtask thiếu parentId.",
      });
    }
  }

  const defectIds = new Set<number>();

  for (const defect of defects) {
    if (defectIds.has(defect.id)) {
      issues.push({
        entityType: "defect",
        entityId: defect.id,
        code: "DUPLICATE_DEFECT_ID",
        message: `Defect ${defect.id} xuất hiện nhiều lần.`,
      });
    }

    defectIds.add(defect.id);

    if (!isValidDefect(defect)) continue;

    if (defect.sourceTaskId === null) {
      issues.push({
        entityType: "defect",
        entityId: defect.id,
        code: "MISSING_SOURCE_TASK",
        message: "Bug hợp lệ phải liên kết với một task nguồn.",
      });
    } else if (!taskIds.has(defect.sourceTaskId)) {
      issues.push({
        entityType: "defect",
        entityId: defect.id,
        code: "SOURCE_TASK_NOT_FOUND",
        message: `Không tìm thấy task nguồn ${defect.sourceTaskId}.`,
      });
    }

    if (
      defect.validatedAt &&
      parseDate(defect.validatedAt) === null
    ) {
      issues.push({
        entityType: "defect",
        entityId: defect.id,
        code: "INVALID_VALIDATED_TIME",
        message: "validatedAt không phải ngày giờ hợp lệ.",
      });
    }
  }

  return issues;
}
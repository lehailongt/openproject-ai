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



import { Router } from "express";

import {
  buildDefectsReport,
  buildPeopleReport,
  validateReportDataset,
  type ReportDataset,
} from "../analytics/report.js";

export const reportsRouter = Router();

/**
 * The provider must be configured by the integration layer.
 *
 * It deliberately defaults to null: the API must not pretend
 * that a real OpenProject data source has been connected.
 */
export type ReportDatasetProvider = (
  projectId: number,
) => Promise<ReportDataset | null>;

let reportDatasetProvider: ReportDatasetProvider | null = null;

export function configureReportDatasetProvider(
  provider: ReportDatasetProvider,
): void {
  reportDatasetProvider = provider;
}

function parseProjectId(value: string | undefined): number | null {
  if (!value) return null;

  const id = Number(value);

  if (!Number.isSafeInteger(id) || id <= 0) {
    return null;
  }

  return id;
}

async function loadDataset(projectId: number) {
  if (!reportDatasetProvider) {
    return {
      dataset: null,
      error: {
        status: 503,
        code: "REPORT_SOURCE_NOT_CONFIGURED",
        message:
          "Nguồn dữ liệu báo cáo chưa được cấu hình. Chưa thể lấy báo cáo thực tế.",
      },
    } as const;
  }

  const dataset = await reportDatasetProvider(projectId);

  if (!dataset) {
    return {
      dataset: null,
      error: {
        status: 404,
        code: "REPORT_DATA_NOT_FOUND",
        message: `Không tìm thấy dữ liệu báo cáo cho project ${projectId}.`,
      },
    } as const;
  }

  if (dataset.report.projectId !== projectId) {
    return {
      dataset: null,
      error: {
        status: 400,
        code: "PROJECT_ID_MISMATCH",
        message:
          "projectId trong dữ liệu không khớp với projectId được yêu cầu.",
      },
    } as const;
  }

  return {
    dataset,
    error: null,
  } as const;
}

/**
 * POST /reports/preview
 *
 * Accepts a normalized dataset for testing the report calculations.
 * This endpoint does not persist data or contact OpenProject.
 */
reportsRouter.post("/reports/preview", (req, res) => {
  const dataset = req.body as ReportDataset;

  if (
    !dataset ||
    typeof dataset !== "object" ||
    !dataset.report ||
    !Array.isArray(dataset.tasks) ||
    !Array.isArray(dataset.defects)
  ) {
    return res.status(400).json({
      error: "INVALID_REPORT_DATASET",
      message:
        "Body phải chứa report, tasks[] và defects[] theo ReportDataset.",
    });
  }

  const issues = validateReportDataset(dataset);

  return res.status(200).json({
    report: dataset.report,
    dataQuality: {
      issueCount: issues.length,
      issues,
    },
    people: buildPeopleReport(dataset),
    defects: buildDefectsReport(dataset),
  });
});

/**
 * GET /reports/people?projectId=10
 */
reportsRouter.get("/reports/people", async (req, res, next) => {
  const projectId = parseProjectId(
    typeof req.query.projectId === "string"
      ? req.query.projectId
      : undefined,
  );

  if (projectId === null) {
    return res.status(400).json({
      error: "INVALID_PROJECT_ID",
      message: "projectId phải là số nguyên dương.",
    });
  }

  try {
    const result = await loadDataset(projectId);

    if (result.error) {
      return res.status(result.error.status).json({
        error: result.error.code,
        message: result.error.message,
      });
    }

    const dataset = result.dataset;

    if (!dataset) {
      return res.status(404).json({
        error: "REPORT_DATA_NOT_FOUND",
        message: "Không tìm thấy dữ liệu báo cáo.",
      });
    }

    return res.json({
      report: dataset.report,
      dataQuality: {
        issueCount: validateReportDataset(dataset).length,
        issues: validateReportDataset(dataset),
      },
      people: buildPeopleReport(dataset),
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * GET /reports/defects?projectId=10
 */
reportsRouter.get("/reports/defects", async (req, res, next) => {
  const projectId = parseProjectId(
    typeof req.query.projectId === "string"
      ? req.query.projectId
      : undefined,
  );

  if (projectId === null) {
    return res.status(400).json({
      error: "INVALID_PROJECT_ID",
      message: "projectId phải là số nguyên dương.",
    });
  }

  try {
    const result = await loadDataset(projectId);

    if (result.error) {
      return res.status(result.error.status).json({
        error: result.error.code,
        message: result.error.message,
      });
    }

    const dataset = result.dataset;

    if (!dataset) {
      return res.status(404).json({
        error: "REPORT_DATA_NOT_FOUND",
        message: "Không tìm thấy dữ liệu báo cáo.",
      });
    }

    const issues = validateReportDataset(dataset);

    return res.json({
      report: dataset.report,
      dataQuality: {
        issueCount: issues.length,
        issues,
      },
      defects: buildDefectsReport(dataset),
    });
  } catch (error) {
    return next(error);
  }
});
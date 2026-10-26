import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

import {
  client,
  type Type,
  type Status,
  type Priority,
  type User,
  type WorkPackage,
} from "../openproject/client.js";

import {
  parseCsv,
  parseJiraDate,
  parseStoryPoints,
  extractJiraIssueKey,
  fetchAllProjectWorkPackages,
  checkProjectStoryPointsSupport,
  findPriority,
  type CsvRecord,
} from "../openproject/jiraCsvToProject.js";

interface CliArgs {
  dryRun: boolean;
  execute: boolean;
  projectId: number;
  csvPath?: string;
  confirmProject?: number;
  expectedIssues?: number;
}

function parseCliArgs(): CliArgs {
  const rawArgs = process.argv.slice(2);
  const args: CliArgs = {
    dryRun: false,
    execute: false,
    projectId: 6,
  };

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];

    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--execute") {
      args.execute = true;
    } else if (arg === "--project-id" && rawArgs[i + 1]) {
      args.projectId = parseInt(rawArgs[++i], 10);
    } else if (arg === "--csv" && rawArgs[i + 1]) {
      args.csvPath = rawArgs[++i];
    } else if (arg === "--confirm-project" && rawArgs[i + 1]) {
      args.confirmProject = parseInt(rawArgs[++i], 10);
    } else if (arg === "--expected-issues" && rawArgs[i + 1]) {
      args.expectedIssues = parseInt(rawArgs[++i], 10);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  console.log(`
========================================================================
  OpenProject Jira CSV Direct Importer (REST API Standalone Script)
========================================================================

Cú pháp:
  npx tsx scripts/import-jira-csv.ts [chế độ] [tùy chọn]

Chế độ (Bắt buộc chọn 1 trong 2):
  --dry-run                 Chỉ phân tích dữ liệu, kiểm tra schema và đối chiếu, KHÔNG ghi dữ liệu.
  --execute                 Thực sự tạo work packages và liên kết cha–con trên OpenProject.

Tùy chọn:
  --project-id <id>         ID dự án đích trong OpenProject (Mặc định: 4).
  --csv <path>              Đường dẫn file CSV (Mặc định: data/Jira (1).csv).
  --confirm-project <id>    Xác nhận ID dự án khi chạy --execute (Bắt buộc phải là 4).
  --expected-issues <count> Xác nhận số lượng issue khi chạy --execute (Bắt buộc: 247).
  --help, -h                Hiển thị hướng dẫn này.

Ví dụ:
  # Chạy kiểm tra Dry-Run an toàn:
  npx tsx scripts/import-jira-csv.ts --dry-run

  # Chạy import thực tế có xác nhận an toàn:
 npx tsx scripts/import-jira-csv.ts --execute --project-id 6 --confirm-project 6 --expected-issues 247
========================================================================
`);
}

function resolveCsvPath(customPath?: string): string {
  const candidates: string[] = [];
  if (customPath) candidates.push(path.resolve(customPath));

  candidates.push(
    path.resolve(process.cwd(), "data/Jira (1).csv"),
    path.resolve(process.cwd(), "../data/Jira (1).csv"),
    path.resolve(process.cwd(), "../../data/Jira (1).csv"),
    "C:\\Projects\\openproject-ai\\data\\Jira (1).csv",
  );

  for (const c of candidates) {
    if (fsSync.existsSync(c)) {
      return c;
    }
  }

  throw new Error(
    `Không tìm thấy file CSV tại bất kỳ đường dẫn nào sau đây:\n${candidates.map((p) => `  - ${p}`).join("\n")}`,
  );
}

// Ánh xạ Type theo yêu cầu nghiêm ngặt
// Ánh xạ Jira Issue Type sang Work Package Type của dự án OpenProject.
export function mapJiraType(
  jiraType: string,
  projectTypes: Type[],
): { type?: Type; warning?: string; error?: string } {
  const raw = (jiraType ?? "").trim();

  if (!raw) {
    return { error: "Thiếu Issue Type trong CSV" };
  }

  // Chuẩn hóa tên Type để so sánh không phân biệt chữ hoa/thường
  // và bỏ khoảng trắng, dấu gạch ngang.
  const normalize = (value: string) =>
    value.toLowerCase().replace(/[\s_-]+/g, "");

  const normalizedInput = normalize(raw);

  // Các tên Type tương đương giữa Jira và OpenProject.
  const aliases: Record<string, string[]> = {
    epic: ["epic"],
    story: ["story", "userstory"],
    "user story": ["story", "userstory"],
    task: ["task"],
    subtask: ["subtask"],
    "sub-task": ["subtask"],
    bug: ["bug"],
    defect: ["bug", "defect"],
  };

  const candidates = aliases[raw.toLowerCase()] ?? [normalizedInput];
  const matched = projectTypes.find((type) =>
    candidates.includes(normalize(type.name)),
  );

  if (!matched) {
    const available = projectTypes.map((type) => `'${type.name}'`).join(", ");

    return {
      error: `Không tìm thấy Type phù hợp cho Jira Type '${raw}'. Types trong project: [${available}]`,
    };
  }

  return { type: matched };
}


// Ánh xạ Status theo danh sách trạng thái OpenProject thực tế
export function mapJiraStatus(
  jiraStatus: string,
  openProjectStatuses: Status[],
): { status?: Status; warning?: string; error?: string } {
  const raw = (jiraStatus ?? "").trim();
  if (!raw) return { error: "Thiếu Status trong CSV" };

  const lower = raw.toLowerCase();

  // 1. Khớp chính xác
  const exact = openProjectStatuses.find((s) => s.name.toLowerCase() === lower);
  if (exact) return { status: exact };

  // 2. Done -> Closed
  if (/^(done|closed|resolved|completed?)$/i.test(lower)) {
    const closed =
      openProjectStatuses.find((s) => /closed|done|resolved/i.test(s.name)) ??
      openProjectStatuses.find((s) => s.isClosed);
    if (closed) return { status: closed };
  }

  // 3. In Progress -> In progress
  if (/^(in progress|in development|developing)$/i.test(lower)) {
    const inProg = openProjectStatuses.find((s) =>
      /in progress/i.test(s.name),
    );
    if (inProg) return { status: inProg };
  }

  // 4. Review -> In testing (hoặc status review nếu có)
  // 4. REVIEW -> In review
  if (/^(review|in review|code review)$/i.test(raw)) {
    const review = openProjectStatuses.find(
      (s) => s.name.trim().toLowerCase() === "in review",
    );

    if (review) {
      return { status: review };
    }
  }

  // 5. READY -> New (hoặc ready / specified)
  // 5. READY -> READY
  if (/^(ready|ready for dev|ready for development)$/i.test(raw)) {
    const ready = openProjectStatuses.find(
      (s) => s.name.trim().toLowerCase() === "ready",
    );

    if (ready) {
      return { status: ready };
    }
  }

  // 6. TO DO -> New
  if (/^(to do|todo|open|new)$/i.test(lower)) {
    const todo =
      openProjectStatuses.find((s) => /^new$/i.test(s.name)) ??
      openProjectStatuses.find((s) => /to do|open/i.test(s.name)) ??
      openProjectStatuses.find((s) => !s.isClosed && s.isDefault);
    if (todo) return { status: todo };
  }

  const available = openProjectStatuses.map((s) => `'${s.name}'`).join(", ");
  return {
    error: `Không thể ánh xạ trạng thái Jira '${raw}' sang OpenProject. Các status khả dụng: [${available}]`,
  };
}

function errorDetail(error: any): string {
  const data = error?.response?.data;
  return data ? JSON.stringify(data) : (error?.message ?? String(error));
}

async function main() {
  const args = parseCliArgs();

  console.log(`\n======================================================`);
  console.log(`  Jira CSV -> OpenProject REST API Importer Script`);
  console.log(`======================================================\n`);

  if (!args.dryRun && !args.execute) {
    console.error(
      `[ERROR] Bạn PHẢI chỉ định một trong hai chế độ: --dry-run hoặc --execute.\n`,
    );
    printHelp();
    process.exit(1);
  }

  if (args.dryRun && args.execute) {
    console.error(
      `[ERROR] Không thể chọn đồng thời cả --dry-run và --execute. Vui lòng chọn 1 chế độ.\n`,
    );
    process.exit(1);
  }

  const mode = args.dryRun ? "dry-run" : "execute";
  console.log(`[Chế độ]: ${mode.toUpperCase()}`);

  // ========================================================
  // BƯỚC 1: XÁC THỰC MÔI TRƯỜNG & KẾT NỐI
  // ========================================================
  const baseUrl = process.env.OPENPROJECT_URL ?? "http://localhost:8080";
  const token = process.env.OPENPROJECT_SERVICE_TOKEN ?? "";

  if (!token) {
    console.error(
      `[ERROR] Thiếu biến môi trường OPENPROJECT_SERVICE_TOKEN trong file .env!`,
    );
    process.exit(1);
  }

  console.log(`[1/5] Kiểm tra kết nối tới OpenProject (${baseUrl})...`);
  try {
    const rootRes = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/v3`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`apikey:${token}`).toString("base64")}`,
        Accept: "application/json",
      },
    });

    if (!rootRes.ok) {
      console.error(
        `[ERROR] Không thể xác thực với OpenProject API v3 (HTTP ${rootRes.status}). Kiểm tra API token!`,
      );
      process.exit(1);
    }

    const rootData = (await rootRes.json()) as any;
    console.log(
      `  -> Kết nối thành công! Phiên bản OpenProject: ${rootData.coreVersion ?? "17.x"}`,
    );
  } catch (err: any) {
    console.error(`[ERROR] Không thể kết nối tới ${baseUrl}: ${err.message}`);
    process.exit(1);
  }

  // ========================================================
  // BƯỚC 2: XÁC THỰC DỰ ÁN & SCHEMA
  // ========================================================
  console.log(`[2/5] Xác thực dự án đích (Project ID: ${args.projectId})...`);
  let project: any;
  try {
    project = await client.getProject(args.projectId);
    console.log(
      `  -> Dự án: "${project.name}" (ID: ${project.id}, Identifier: "${project.identifier}")`,
    );
  } catch (err: any) {
    console.error(
      `[ERROR] Không tìm thấy dự án ID ${args.projectId}: ${errorDetail(err)}`,
    );
    process.exit(1);
  }

  // Ràng buộc an toàn cho chế độ --execute
  // Ràng buộc an toàn cho chế độ --execute: chỉ cho phép dự án PICKLEBALL.
  if (args.execute) {
    if (
      args.projectId !== 6 ||
      project.identifier !== "pickleball"
    ) {
      console.error(
        `[SAFETY VIOLATION] Chỉ được import vào dự án PICKLEBALL (ID 6, identifier pickleball).`,
      );
      process.exit(1);
    }

    if (args.confirmProject !== 6 || args.expectedIssues !== 247) {
      console.error(
        `\n[SAFETY CHECKPOINT] Để chạy import thật, cần xác nhận đúng dự án và số issue.`,
      );
      console.error(
        `Chạy với: --execute --project-id 6 --confirm-project 6 --expected-issues 247\n`,
      );
      process.exit(1);
    }
  }

  const projectTypes =
    (await client.getProjectTypes(args.projectId))._embedded?.elements ?? [];
  if (projectTypes.length === 0) {
    console.error(`[ERROR] Dự án ${args.projectId} không có Work Package Type nào!`);
    process.exit(1);
  }
  console.log(
    `  -> Work Package Types khả dụng: [${projectTypes.map((t) => t.name).join(", ")}]`,
  );

  const statuses =
    (await client.listStatuses())._embedded?.elements ?? [];
  if (statuses.length === 0) {
    console.error(`[ERROR] OpenProject không trả về Status nào!`);
    process.exit(1);
  }

  const priorities =
    (await client.listPriorities())._embedded?.elements ?? [];

  const availableAssignees =
    (await client.listProjectAvailableAssignees(args.projectId))._embedded
      ?.elements ?? [];
  console.log(
    `  -> Thành viên có thể gán việc trong dự án: ${availableAssignees.length} user`,
  );

  const supportsStoryPoints = await checkProjectStoryPointsSupport(
    args.projectId,
    projectTypes[0].id,
  );
  console.log(
    `  -> Tính năng Story Points: ${supportsStoryPoints ? "ĐÃ BẬT (ghi trực tiếp vào schema)" : "CHƯA BẬT (sẽ bảo toàn trong Description)"}`,
  );

  // Quét danh sách issue hiện có trong dự án
  console.log(`[3/5] Quét các work package hiện có trong dự án để chống tạo trùng...`);
  const existingWps = await fetchAllProjectWorkPackages(args.projectId);
  const existingWpByIssueKey = new Map<string, WorkPackage>();

  for (const wp of existingWps) {
    const key = extractJiraIssueKey(wp.subject);
    if (key) {
      existingWpByIssueKey.set(key, wp);
    }
  }

  console.log(
    `  -> Số work package hiện có trong dự án: ${existingWps.length} (trong đó ${existingWpByIssueKey.size} có Jira key).`,
  );

  // ========================================================
  // BƯỚC 3: ĐỌC & PHÂN TÍCH CSV
  // ========================================================
  const csvPath = resolveCsvPath(args.csvPath);
  console.log(`[4/5] Đọc file CSV: ${csvPath}`);
  const csvContent = await fs.readFile(csvPath, "utf8");
  const records = parseCsv(csvContent);

  if (records.length === 0) {
    console.error(`[ERROR] File CSV rỗng hoặc không thể parse.`);
    process.exit(1);
  }

  console.log(`  -> Tổng số dòng issue trong CSV: ${records.length}`);

  // Bảng thống kê
  const typeStats: Record<string, number> = {};
  const statusStats: Record<string, number> = {};
  const duplicateCsvKeys: string[] = [];
  const issueKeyToRow = new Map<string, CsvRecord>();

  const warnings: { issueKey: string; message: string }[] = [];
  const errors: { issueKey: string; httpStatus?: number; message: string }[] = [];
  const parentLinkErrors: { issueKey: string; parentKey: string; message: string }[] = [];

  let spCount = 0;
  let totalSp = 0;
  let startDateCount = 0;
  let dueDateCount = 0;
  let labelsCount = 0;
  let jiraAssigneeCount = 0;
  let mappedAssigneeCount = 0;
  let parentKeyCount = 0;

  for (const row of records) {
    const key = (row["Issue key"] ?? "").trim();
    if (!key) {
      errors.push({
        issueKey: "(không có key)",
        message: "Dòng CSV thiếu cột Issue key.",
      });
      continue;
    }

    if (issueKeyToRow.has(key)) {
      duplicateCsvKeys.push(key);
      warnings.push({
        issueKey: key,
        message: "Issue key bị lặp lại trong CSV; bỏ qua dòng trùng lặp.",
      });
      continue;
    }

    issueKeyToRow.set(key, row);

    // Thống kê type
    const jType = row["Issue Type"] ?? "(rỗng)";
    typeStats[jType] = (typeStats[jType] || 0) + 1;

    // Thống kê status
    const jStatus = row["Status"] ?? "(rỗng)";
    statusStats[jStatus] = (statusStats[jStatus] || 0) + 1;

    // Thống kê story points
    const sp = parseStoryPoints(row);
    if (sp !== undefined) {
      spCount++;
      totalSp += sp;
    }

    // Thống kê ngày
    if (parseJiraDate(row["Custom field (Start date)"] ?? row["Start date"] ?? "")) {
      startDateCount++;
    }
    if (parseJiraDate(row["Due date"] ?? "")) {
      dueDateCount++;
    }

    // Thống kê nhãn
    if (row._allLabels && row._allLabels.length > 0) {
      labelsCount++;
    }

    // Thống kê assignee
    const jAssignee = (row["Assignee"] ?? "").trim();
    if (jAssignee) {
      jiraAssigneeCount++;
      const norm = jAssignee.toLowerCase();
      const matched = availableAssignees.find(
        (u) =>
          u.name?.toLowerCase() === norm ||
          u.login?.toLowerCase() === norm ||
          u.email?.toLowerCase() === norm,
      );
      if (matched) {
        mappedAssigneeCount++;
      }
    }

    // Thống kê parent key
    if ((row["Parent key"] ?? "").trim()) {
      parentKeyCount++;
    }
  }

  console.log(`\n--- Tóm tắt phân tích dữ liệu CSV ---`);
  console.log(`  * Tổng số issue hợp lệ duy nhất: ${issueKeyToRow.size}`);
  console.log(`  * Thống kê Issue Type:`, typeStats);
  console.log(`  * Thống kê Status:`, statusStats);
  console.log(`  * Issues có Story Points: ${spCount} (Tổng điểm: ${totalSp})`);
  console.log(`  * Issues có Start date: ${startDateCount} | Due date: ${dueDateCount}`);
  console.log(`  * Issues có Labels: ${labelsCount} (Toàn bộ được gộp và bảo toàn)`);
  console.log(
    `  * Assignee: ${jiraAssigneeCount} có người gán (${mappedAssigneeCount} khớp thành viên OP, còn lại lưu Description)`,
  );
  console.log(`  * Issues có quan hệ cha-con (Parent key): ${parentKeyCount}`);

  // ========================================================
  // BƯỚC 4: THỰC THI (DRY-RUN HOẶC EXECUTE)
  // ========================================================
  console.log(`\n[5/5] Tiến hành xử lý ở chế độ ${mode.toUpperCase()}...`);

  const mapping: Record<string, number> = {};
  let plannedCreated = 0;
  let createdCount = 0;
  let skippedExisting = 0;
  let plannedParentLinks = 0;
  let createdParentLinks = 0;

  // LƯỢT 1: Tạo work package (hoặc giả lập tạo nếu dry-run)
  for (const [issueKey, row] of issueKeyToRow) {
    // 1. Kiểm tra chống trùng: Nếu issue đã tồn tại trên OpenProject -> BỎ QUA
    const existingWp = existingWpByIssueKey.get(issueKey);
    if (existingWp) {
      mapping[issueKey] = existingWp.id;
      skippedExisting++;
      continue;
    }

    // 2. Ánh xạ Type
    const typeRes = mapJiraType(row["Issue Type"] ?? "", projectTypes);
    if (typeRes.error || !typeRes.type) {
      errors.push({
        issueKey,
        message: typeRes.error ?? "Lỗi ánh xạ Type",
      });
      continue;
    }
    if (typeRes.warning) {
      warnings.push({ issueKey, message: typeRes.warning });
    }

    // 3. Ánh xạ Status
    const statusRes = mapJiraStatus(row["Status"] ?? "", statuses);
    if (statusRes.error || !statusRes.status) {
      errors.push({
        issueKey,
        message: statusRes.error ?? "Lỗi ánh xạ Status",
      });
      continue;
    }
    if (statusRes.warning) {
      warnings.push({ issueKey, message: statusRes.warning });
    }

    const summary = (row["Summary"] ?? "").trim() || issueKey;
    const priority = findPriority(row["Priority"] ?? "", priorities);
    const startDate = parseJiraDate(
      row["Custom field (Start date)"] ?? row["Start date"] ?? "",
    );
    const dueDate = parseJiraDate(row["Due date"] ?? "");
    const storyPoints = parseStoryPoints(row);

    // Chuẩn bị Description bảo toàn các trường
    const descriptionParts: string[] = [];
    const origDesc = (row["Description"] ?? "").trim();
    if (origDesc) descriptionParts.push(origDesc);

    const assignee = (row["Assignee"] ?? "").trim();
    const reporter = (row["Reporter"] ?? "").trim();
    if (assignee) descriptionParts.push(`Assignee (Jira): ${assignee}`);
    if (reporter) descriptionParts.push(`Reporter (Jira): ${reporter}`);

    const labels = row._allLabels ?? [];
    if (labels.length > 0) {
      descriptionParts.push(`Labels (Jira): ${labels.join(", ")}`);
    }

    if (storyPoints !== undefined) {
      descriptionParts.push(`Story Points (Jira): ${storyPoints}`);
    }

    const fullDescription =
      descriptionParts.length > 0 ? descriptionParts.join("\n\n") : undefined;

    // Ánh xạ assignee nếu hợp lệ
    let assigneeId: number | undefined;
    if (assignee) {
      const norm = assignee.toLowerCase();
      const matched = availableAssignees.find(
        (u) =>
          u.name?.toLowerCase() === norm ||
          u.login?.toLowerCase() === norm ||
          u.email?.toLowerCase() === norm,
      );
      if (matched) assigneeId = matched.id;
    }

    if (args.dryRun) {
      // Trong chế độ dry-run: Tuyệt đối không gửi request ghi
      plannedCreated++;
      mapping[issueKey] = 90000 + plannedCreated; // ID giả lập để test lượt 2
    } else {
      // Chế độ --execute: Tạo work package thật
      try {
        const payload: Parameters<typeof client.createWorkPackage>[0] = {
          subject: `[${issueKey}] ${summary}`.slice(0, 255),
          description: fullDescription,
          projectId: args.projectId,
          typeId: typeRes.type.id,
          statusId: statusRes.status.id,
          priorityId: priority?.id,
          assigneeId,
          startDate,
          dueDate,
        };

        if (supportsStoryPoints && storyPoints !== undefined) {
          payload.storyPoints = storyPoints;
        }

        let wp: WorkPackage;
        try {
          wp = await client.createWorkPackage(payload);
        } catch (createErr: any) {
          // Fallback nếu OpenProject từ chối ghi thuộc tính storyPoints
          if (
            payload.storyPoints !== undefined &&
            (createErr?.response?.data?.message?.includes("Story Points") ||
              createErr?.response?.data?._embedded?.errors?.some(
                (e: any) => e?._embedded?.details?.attribute === "storyPoints",
              ))
          ) {
            delete payload.storyPoints;
            wp = await client.createWorkPackage(payload);
            warnings.push({
              issueKey,
              message: `OpenProject từ chối trường storyPoints; điểm ${storyPoints} đã được bảo toàn trong Description.`,
            });
          } else {
            throw createErr;
          }
        }

        mapping[issueKey] = wp.id;
        createdCount++;
        process.stdout.write(`\r  -> Đã tạo: ${createdCount} work packages...`);
      } catch (err: any) {
        errors.push({
          issueKey,
          httpStatus: err?.response?.status,
          message: errorDetail(err),
        });
      }
    }
  }

  if (args.execute) {
    console.log(`\n  -> Hoàn thành Lượt 1: Tạo mới ${createdCount} work packages.`);
  }

  // LƯỢT 2: Liên kết quan hệ cha–con
  console.log(`  -> Đang tiến hành Lượt 2: Liên kết quan hệ cha–con theo Parent key...`);
  for (const [issueKey, row] of issueKeyToRow) {
    const parentKey = (row["Parent key"] ?? "").trim();
    if (!parentKey) continue;

    const childId = mapping[issueKey];
    if (!childId) continue;

    const parentId = mapping[parentKey];
    if (!parentId) {
      parentLinkErrors.push({
        issueKey,
        parentKey,
        message: `Không tìm thấy ID OpenProject của issue cha '${parentKey}'.`,
      });
      continue;
    }

    if (args.dryRun) {
      plannedParentLinks++;
    } else {
      try {
        const current = await client.getWorkPackage(childId);
        if (current._links?.parent?.href === `/api/v3/work_packages/${parentId}`) {
          createdParentLinks++;
          continue;
        }

        await client.updateWorkPackage(childId, {
          parentId,
          lockVersion: current.lockVersion,
        });
        createdParentLinks++;
      } catch (err: any) {
        parentLinkErrors.push({
          issueKey,
          parentKey,
          message: errorDetail(err),
        });
      }
    }
  }

  // ========================================================
  // BƯỚC 5: TỔNG HỢP & LƯU BÁO CÁO
  // ========================================================
  const now = new Date();
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .split(".")[0];

  const reportDir = path.resolve(process.cwd(), "reports");
  await fs.mkdir(reportDir, { recursive: true });

  const reportFileName = `jira-import-${mode}-${timestamp}.json`;
  const reportFilePath = path.join(reportDir, reportFileName);

  const reportData = {
    mode,
    timestamp: now.toISOString(),
    project: {
      id: project.id,
      name: project.name,
      identifier: project.identifier,
    },
    csvFile: csvPath,
    statistics: {
      totalCsvRows: records.length,
      uniqueJiraKeys: issueKeyToRow.size,
      duplicateCsvKeysCount: duplicateCsvKeys.length,
      existingIssuesInProjectCount: existingWpByIssueKey.size,
      plannedOrActualCreatedCount: args.dryRun ? plannedCreated : createdCount,
      skippedExistingCount: skippedExisting,
      failedIssuesCount: errors.length,
      plannedOrActualParentLinksCount: args.dryRun
        ? plannedParentLinks
        : createdParentLinks,
      parentLinkErrorsCount: parentLinkErrors.length,
    },
    typeBreakdown: typeStats,
    statusBreakdown: statusStats,
    fieldPreservationSummary: {
      storyPoints: {
        supportedNatively: supportsStoryPoints,
        issuesWithStoryPoints: spCount,
        totalPoints: totalSp,
        action: supportsStoryPoints
          ? "Ghi vào trường storyPoints và lưu trữ trong Description"
          : "Bảo toàn an toàn trong Description",
      },
      dates: {
        issuesWithStartDate: startDateCount,
        issuesWithDueDate: dueDateCount,
        action: "Ánh xạ chuẩn sang startDate và dueDate của OpenProject",
      },
      labels: {
        issuesWithLabels: labelsCount,
        action:
          "OpenProject Community không có trường native Labels; toàn bộ nhãn được bảo toàn vào Description dạng 'Labels (Jira): ...'",
      },
      assigneeAndReporter: {
        jiraAssigneeCount,
        mappedToOpenProjectUserCount: mappedAssigneeCount,
        action:
          "Gán assigneeId cho user hợp lệ trong dự án; toàn bộ tên Assignee & Reporter gốc được bảo toàn trong Description",
      },
    },
    duplicateCsvKeys,
    errors,
    parentLinkErrors,
    warnings,
  };

  await fs.writeFile(reportFilePath, JSON.stringify(reportData, null, 2), "utf8");

  console.log(`\n======================================================`);
  console.log(`  BÁO CÁO KẾT QUẢ ${mode.toUpperCase()}`);
  console.log(`======================================================`);
  console.log(`  * Dự án: ${project.name} (ID: ${project.id})`);
  console.log(`  * File CSV: ${csvPath}`);
  console.log(`  * Tổng số issue trong CSV: ${records.length}`);
  console.log(
    `  * Số issue sẽ tạo mới: ${args.dryRun ? plannedCreated : createdCount}`,
  );
  console.log(
    `  * Số issue bỏ qua (đã tồn tại): ${skippedExisting}`,
  );
  console.log(
    `  * Số liên kết cha-con: ${args.dryRun ? plannedParentLinks : createdParentLinks}`,
  );
  console.log(`  * Lỗi tạo issue: ${errors.length}`);
  console.log(`  * Lỗi liên kết parent: ${parentLinkErrors.length}`);
  console.log(`  * Cảnh báo: ${warnings.length}`);
  console.log(`  * File báo cáo chi tiết: ${reportFilePath}`);
  console.log(`======================================================\n`);
}

main().catch((err) => {
  console.error(`\n[FATAL ERROR] Quá trình import gặp lỗi:`, err);
  process.exit(1);
});

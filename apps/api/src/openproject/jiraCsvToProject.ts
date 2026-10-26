import {
  client,
  type Type,
  type Status,
  type Priority,
  type User,
  type WorkPackage,
} from "./client.js";

export interface CsvRecord {
  [key: string]: any;
  _allLabels?: string[];
}

// CSV parser: handles quoted commas, escaped quotes, and embedded newlines.
// Bảo toàn tất cả các cột 'Labels' trùng tên, lọc rỗng và deduplicate.
export function parseCsv(content: string): CsvRecord[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);

  for (let i = 0; i < content.length; i++) {
    const c = content[i];

    if (inQuotes) {
      if (c === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && field.length === 0) {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }

  if (rows.length === 0) return [];

  const headers = rows[0].map((h) => h.trim());

  return rows
    .slice(1)
    .filter((r) => !(r.length === 1 && r[0] === ""))
    .map((values) => {
      const record: CsvRecord = {};
      const labelsSet = new Set<string>();

      headers.forEach((header, index) => {
        const val = values[index] ?? "";
        const trimmedVal = val.trim();

        // 4. Bảo toàn tất cả cột Labels trùng tên, loại bỏ giá trị rỗng và trùng lặp
        if (header.toLowerCase() === "labels" && trimmedVal) {
          labelsSet.add(trimmedVal);
        }

        // Nếu CSV có header trùng khác, giữ giá trị không rỗng đầu tiên
        if (!(header in record) || !record[header]) {
          record[header] = val;
        }
      });

      const allLabels = Array.from(labelsSet);
      record._allLabels = allLabels;
      if (allLabels.length > 0) {
        record["Labels"] = allLabels.join(", ");
      }

      return record;
    });
}

export function parseJiraDate(value: string): string | undefined {
  if (!value?.trim()) return undefined;

  const datePart = value.trim().split(/[ T]/)[0];

  const namedMonth = datePart.match(
    /^(\d{1,2})\/([A-Za-z]{3})\/(\d{2}|\d{4})$/,
  );

  if (namedMonth) {
    const months: Record<string, string> = {
      jan: "01",
      feb: "02",
      mar: "03",
      apr: "04",
      may: "05",
      jun: "06",
      jul: "07",
      aug: "08",
      sep: "09",
      oct: "10",
      nov: "11",
      dec: "12",
    };

    const month = months[namedMonth[2].toLowerCase()];
    let year = namedMonth[3];

    if (year.length === 2) {
      year = `${Number(year) >= 70 ? "19" : "20"}${year}`;
    }

    if (month) {
      return `${year}-${month}-${namedMonth[1].padStart(2, "0")}`;
    }
  }

  // Jira thường xuất ngày dạng d/M/yyyy.
  const numeric = datePart.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);

  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);

    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      return `${numeric[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    return datePart;
  }

  return undefined;
}

export function parseStoryPoints(row: Record<string, string>): number | undefined {
  const raw =
    row["Custom field (Story point estimate)"] ??
    row["Custom field (Story Points)"] ??
    row["Story Points"] ??
    row["Story point estimate"];

  if (!raw || !raw.trim()) return undefined;

  const num = Number(raw.trim());
  if (isNaN(num)) return undefined;

  return Math.round(num);
}

export function extractJiraIssueKey(subject: string): string | null {
  const match = subject.match(/^\[([A-Za-z0-9_ -]+)\]/);
  return match ? match[1].trim() : null;
}

export async function fetchAllProjectWorkPackages(
  projectId: number,
): Promise<WorkPackage[]> {
  const all: WorkPackage[] = [];
  let page = 1;
  const pageSize = 100;

  while (true) {
    const res = await client.listWorkPackages({
      filters: JSON.stringify([
        { project: { operator: "=", values: [String(projectId)] } },
      ]),
      page,
      perPage: pageSize,
    });
    const elements = res._embedded?.elements ?? [];
    all.push(...elements);
    if (all.length >= res.total || elements.length === 0) {
      break;
    }
    page++;
  }

  return all;
}

export async function checkProjectStoryPointsSupport(
  projectId: number,
  firstTypeId: number,
): Promise<boolean> {
  try {
    const schema = await client.getWorkPackageSchema(projectId, firstTypeId);
    return schema?.storyPoints?.writable === true;
  } catch {
    return false;
  }
}

export interface ImportJiraCsvOptions {
  filePath?: string;
  csvContent: string;
  existingProjectId?: number;
  projectName?: string;
  projectIdentifier?: string;
  description?: string;
  parentId?: number;
  public?: boolean;
  mode?: "create_only" | "upsert";
  userMapping?: Record<string, number>;
}

export interface ImportJiraCsvReport {
  projectId: number;
  projectIdentifier: string;
  projectName: string;
  mode: "create_only" | "upsert";
  totalRows: number;
  createdWorkPackages: number;
  updatedWorkPackages: number;
  skipped: number;
  parentLinksCreated: number;
  parentLinkErrors: {
    issueKey: string;
    parentKey: string;
    message: string;
  }[];
  errors: {
    issueKey: string;
    message: string;
  }[];
  warnings: {
    issueKey: string;
    message: string;
  }[];
  mapping: Record<string, number>;
}

function errorDetail(error: any): string {
  const data = error?.response?.data;
  return data ? JSON.stringify(data) : (error?.message ?? String(error));
}

// 7. Rà soát ánh xạ Type: báo lỗi rõ ràng nếu không tìm thấy type phù hợp, không âm thầm fallback
export function findType(
  jiraType: string,
  types: Type[],
): { type?: Type; warning?: string; error?: string } {
  const raw = jiraType?.trim();
  if (!raw) {
    return { error: "Dòng CSV thiếu cột Issue Type." };
  }

  const n = raw.toLowerCase();

  const exact = types.find((t) => t.name.trim().toLowerCase() === n);
  if (exact) return { type: exact };

  const aliases: Record<string, { patterns: RegExp[]; isSubtask?: boolean }> = {
    epic: { patterns: [/^epic$/i, /milestone/i, /feature/i] },
    story: { patterns: [/^user story$/i, /^story$/i, /feature/i, /task/i] },
    subtask: { patterns: [/^sub[- ]?task$/i, /^task$/i], isSubtask: true },
    task: { patterns: [/^task$/i] },
    bug: { patterns: [/^bug$/i, /defect/i] },
  };

  const aliasConfig = aliases[n];
  if (aliasConfig) {
    for (const pattern of aliasConfig.patterns) {
      const found = types.find((t) => pattern.test(t.name));
      if (found) {
        return {
          type: found,
          warning:
            aliasConfig.isSubtask && !/subtask/i.test(found.name)
              ? `Jira Issue Type '${raw}' được ánh xạ sang '${found.name}' do OpenProject không có type Subtask riêng.`
              : undefined,
        };
      }
    }
  }

  const available = types.map((t) => `'${t.name}'`).join(", ");
  return {
    error: `Không tìm thấy Work Package Type phù hợp trong OpenProject cho Jira Issue Type '${raw}'. Các type khả dụng trong project: [${available}].`,
  };
}

// 7. Rà soát ánh xạ Status: báo lỗi rõ ràng nếu không tìm thấy status phù hợp, không âm thầm fallback
export function findStatus(
  jiraStatus: string,
  statuses: Status[],
): { status?: Status; warning?: string; error?: string } {
  const raw = jiraStatus?.trim();
  if (!raw) {
    const fallback =
      statuses.find((s) => !s.isClosed && s.isDefault) ??
      statuses.find((s) => !s.isClosed) ??
      statuses[0];
    return {
      status: fallback,
      warning: `Jira Status bị rỗng; dùng trạng thái mặc định '${fallback.name}'.`,
    };
  }

  const n = raw.toLowerCase();

  const exact = statuses.find((s) => s.name.trim().toLowerCase() === n);
  if (exact) return { status: exact };

  const statusPatterns: Array<{ source: RegExp; target: RegExp }> = [
    {
      source: /^(done|closed|resolved|complete|completed)$/i,
      target: /closed|done|resolved/i,
    },
    {
      source: /^(in progress|in development|developing)$/i,
      target: /in progress/i,
    },
    {
      source: /^(review|in review|code review)$/i,
      target: /review|testing|in testing/i,
    },
    {
      source: /^(ready|ready for dev|ready for development)$/i,
      target: /ready|confirmed|scheduled|^new$/i,
    },
    {
      source: /^(to do|todo|open|new)$/i,
      target: /^new$|to do|open/i,
    },
  ];

  for (const { source, target } of statusPatterns) {
    if (source.test(n)) {
      const found = statuses.find((s) => target.test(s.name));
      if (found) return { status: found };
    }
  }

  const available = statuses.map((s) => `'${s.name}'`).join(", ");
  return {
    error: `Không tìm thấy Status phù hợp trong OpenProject cho Jira Status '${raw}'. Các status khả dụng: [${available}].`,
  };
}

// Ánh xạ mức ưu tiên
export function findPriority(
  jiraPriority: string,
  priorities: Priority[],
): Priority | undefined {
  const n = jiraPriority?.trim().toLowerCase();
  if (!n || priorities.length === 0) return undefined;

  const exact = priorities.find((p) => p.name.trim().toLowerCase() === n);
  if (exact) return exact;

  if (/medium|normal|major/i.test(n)) {
    return priorities.find((p) => /normal|medium/i.test(p.name));
  }

  if (/highest|blocker|critical|immediate/i.test(n)) {
    return priorities.find((p) => /immediate|highest|critical/i.test(p.name));
  }

  if (/high/i.test(n)) {
    return priorities.find((p) => /high/i.test(p.name));
  }

  if (/low|lowest|minor/i.test(n)) {
    return priorities.find((p) => /low/i.test(p.name));
  }

  return undefined;
}

// 6. Ánh xạ Assignee: chỉ gán sang user OpenProject khi tìm được ánh xạ hợp lệ, giữ nguyên trong description
export function resolveAssignee(
  row: Record<string, string>,
  availableAssignees: User[],
  userMapping?: Record<string, number>,
): { assigneeId?: number; warning?: string } {
  const assigneeText = (row["Assignee"] ?? "").trim();
  const assigneeIdText = (row["Assignee Id"] ?? "").trim();

  if (!assigneeText && !assigneeIdText) {
    return {};
  }

  // 1. Kiểm tra bảng userMapping (nếu có cấu hình thủ công)
  if (userMapping) {
    if (assigneeIdText && userMapping[assigneeIdText]) {
      return { assigneeId: userMapping[assigneeIdText] };
    }
    if (assigneeText && userMapping[assigneeText]) {
      return { assigneeId: userMapping[assigneeText] };
    }
  }

  // 2. Tìm trong availableAssignees của project theo name, login, email
  const normName = assigneeText.toLowerCase();
  const matched = availableAssignees.find((u) => {
    return (
      (u.name && u.name.toLowerCase() === normName) ||
      (u.login && u.login.toLowerCase() === normName) ||
      (u.email && u.email.toLowerCase() === normName)
    );
  });

  if (matched) {
    return { assigneeId: matched.id };
  }

  return {
    warning: `Assignee Jira '${assigneeText}' chưa có tài khoản tương ứng trong danh sách thành viên dự án OpenProject; đã ghi nhận vào Description.`,
  };
}

export async function jiraCsvToProject(
  opts: ImportJiraCsvOptions,
): Promise<ImportJiraCsvReport> {
  const records = parseCsv(opts.csvContent);

  if (records.length === 0) {
    throw new Error("CSV rỗng hoặc không đọc được.");
  }

  const mode = opts.mode ?? "create_only";
  const hasExistingProject = opts.existingProjectId !== undefined;

  if (
    !hasExistingProject &&
    (!opts.projectName?.trim() || !opts.projectIdentifier?.trim())
  ) {
    throw new Error(
      "Cần truyền existingProjectId hoặc đồng thời projectName và projectIdentifier.",
    );
  }

  // Dùng project có sẵn nếu người dùng truyền existingProjectId.
  const project = hasExistingProject
    ? await client.getProject(opts.existingProjectId!)
    : await client.createProject({
        name: opts.projectName!.trim(),
        identifier: opts.projectIdentifier!.trim(),
        description: opts.description,
        parentId: opts.parentId,
        public: opts.public ?? false,
      });

  const projectId = project.id;

  const types =
    (await client.getProjectTypes(projectId))._embedded?.elements ?? [];

  if (types.length === 0) {
    throw new Error(
      `Project ${projectId} không có Work Package Type khả dụng.`,
    );
  }

  const statuses =
    (await client.listStatuses())._embedded?.elements ?? [];

  if (statuses.length === 0) {
    throw new Error("OpenProject không trả về Status nào.");
  }

  const priorities =
    (await client.listPriorities())._embedded?.elements ?? [];

  // Danh sách người dùng được phép gán trong project
  const availableAssignees =
    (await client.listProjectAvailableAssignees(projectId))._embedded?.elements ?? [];

  // Kiểm tra tính năng Story Points có được bật và ghi được không
  const projectSupportsStoryPoints = await checkProjectStoryPointsSupport(
    projectId,
    types[0].id,
  );

  const warnings: { issueKey: string; message: string }[] = [];

  if (!projectSupportsStoryPoints) {
    warnings.push({
      issueKey: "(Dự án)",
      message:
        "Dự án này chưa bật tính năng Story Points (hoặc thiếu module Backlogs trong OpenProject). Story point estimate từ Jira sẽ được lưu trữ an toàn trong trường Description.",
    });
  }

  // 1. Quét work package hiện có để chống tạo trùng khi chạy lại
  const existingWps = await fetchAllProjectWorkPackages(projectId);
  const existingWpByIssueKey = new Map<string, WorkPackage>();

  for (const wp of existingWps) {
    const key = extractJiraIssueKey(wp.subject);
    if (key) {
      existingWpByIssueKey.set(key, wp);
    }
  }

  const issueKeyToRow = new Map<string, CsvRecord>();
  const mapping: Record<string, number> = {};

  const errors: {
    issueKey: string;
    message: string;
  }[] = [];

  const parentLinkErrors: {
    issueKey: string;
    parentKey: string;
    message: string;
  }[] = [];

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let parentLinksCreated = 0;

  // Kiểm tra Issue key trùng trong file CSV trước khi import
  for (const row of records) {
    const key = (row["Issue key"] ?? "").trim();

    if (key) {
      if (issueKeyToRow.has(key)) {
        errors.push({
          issueKey: key,
          message: "Issue key bị trùng trong CSV; bỏ qua dòng trùng.",
        });
        skipped++;
        continue;
      }

      issueKeyToRow.set(key, row);
    }
  }

  // ==========================================================
  // LƯỢT 1: Tạo mới hoặc cập nhật work package (chưa gắn parent)
  // ==========================================================
  for (const row of records) {
    const issueKey = (row["Issue key"] ?? "").trim();

    if (!issueKey) {
      errors.push({
        issueKey: "(không có Issue key)",
        message: "Dòng CSV thiếu cột Issue key.",
      });
      skipped++;
      continue;
    }

    // Chỉ xử lý lần xuất hiện đầu tiên của một Issue key
    if (
      mapping[issueKey] !== undefined ||
      errors.some(
        (e) => e.issueKey === issueKey && e.message.includes("trùng"),
      )
    ) {
      continue;
    }

    // 7. Rà soát Type & Status
    const typeResult = findType(row["Issue Type"] ?? "", types);
    if (typeResult.error || !typeResult.type) {
      errors.push({
        issueKey,
        message: typeResult.error ?? "Lỗi xác định Type.",
      });
      skipped++;
      continue;
    }
    if (typeResult.warning) {
      warnings.push({ issueKey, message: typeResult.warning });
    }

    const statusResult = findStatus(row["Status"] ?? "", statuses);
    if (statusResult.error || !statusResult.status) {
      errors.push({
        issueKey,
        message: statusResult.error ?? "Lỗi xác định Status.",
      });
      skipped++;
      continue;
    }
    if (statusResult.warning) {
      warnings.push({ issueKey, message: statusResult.warning });
    }

    const summary = (row["Summary"] ?? "").trim() || issueKey;
    const type = typeResult.type;
    const status = statusResult.status;
    const priority = findPriority(row["Priority"] ?? "", priorities);

    // 3. Start date và Due date
    const startDate = parseJiraDate(
      row["Custom field (Start date)"] ?? row["Start date"] ?? "",
    );
    const dueDate = parseJiraDate(row["Due date"] ?? "");

    // 2. Story points
    const storyPoints = parseStoryPoints(row);

    // 6. Assignee & Reporter
    const assigneeResult = resolveAssignee(row, availableAssignees, opts.userMapping);
    if (assigneeResult.warning) {
      warnings.push({ issueKey, message: assigneeResult.warning });
    }

    const descriptionParts: string[] = [];
    const originalDescription = (row["Description"] ?? "").trim();
    if (originalDescription) {
      descriptionParts.push(originalDescription);
    }

    const assignee = (row["Assignee"] ?? "").trim();
    const reporter = (row["Reporter"] ?? "").trim();

    if (assignee) {
      descriptionParts.push(`Assignee (Jira): ${assignee}`);
    }
    if (reporter) {
      descriptionParts.push(`Reporter (Jira): ${reporter}`);
    }

    // 4 & 5. Labels: bảo toàn vào description (do OpenProject Community không có trường native tags)
    const labels = row._allLabels ?? [];
    if (labels.length > 0) {
      descriptionParts.push(`Labels (Jira): ${labels.join(", ")}`);
    }

    if (storyPoints !== undefined) {
      descriptionParts.push(`Story Points (Jira): ${storyPoints}`);
    }

    const fullDescription =
      descriptionParts.length > 0 ? descriptionParts.join("\n\n") : undefined;

    const existingWp = existingWpByIssueKey.get(issueKey);

    // 1. Chống trùng lặp theo chế độ
    if (existingWp) {
      mapping[issueKey] = existingWp.id;

      if (mode === "create_only") {
        skipped++;
        warnings.push({
          issueKey,
          message: `Issue '${issueKey}' đã tồn tại trong OpenProject (WP #${existingWp.id}). Bỏ qua vì đang ở chế độ create_only.`,
        });
        continue;
      }

      // mode === 'upsert': cập nhật issue đã tồn tại
      try {
        const updatePayload: Parameters<typeof client.updateWorkPackage>[1] = {
          subject: `[${issueKey}] ${summary}`.slice(0, 255),
          description: fullDescription,
          typeId: type.id,
          statusId: status.id,
          priorityId: priority?.id,
          assigneeId: assigneeResult.assigneeId,
          startDate,
          dueDate,
          lockVersion: existingWp.lockVersion,
        };

        if (projectSupportsStoryPoints && storyPoints !== undefined) {
          updatePayload.storyPoints = storyPoints;
        }

        const updatedWp = await client.updateWorkPackage(
          existingWp.id,
          updatePayload,
        );

        existingWpByIssueKey.set(issueKey, updatedWp);
        updated++;
      } catch (error: any) {
        errors.push({
          issueKey,
          message: `Lỗi cập nhật WP #${existingWp.id}: ${errorDetail(error)}`,
        });
        skipped++;
      }

      continue;
    }

    // Tạo mới work package
    try {
      const createPayload: Parameters<typeof client.createWorkPackage>[0] = {
        subject: `[${issueKey}] ${summary}`.slice(0, 255),
        description: fullDescription,
        projectId,
        typeId: type.id,
        statusId: status.id,
        priorityId: priority?.id,
        assigneeId: assigneeResult.assigneeId,
        startDate,
        dueDate,
      };

      if (projectSupportsStoryPoints && storyPoints !== undefined) {
        createPayload.storyPoints = storyPoints;
      }

      let wp: WorkPackage;
      try {
        wp = await client.createWorkPackage(createPayload);
      } catch (createErr: any) {
        // Fallback an toàn nếu API từ chối trường storyPoints readonly
        if (
          createPayload.storyPoints !== undefined &&
          (createErr?.response?.data?.message?.includes("Story Points") ||
            createErr?.response?.data?._embedded?.errors?.some(
              (e: any) => e?._embedded?.details?.attribute === "storyPoints",
            ))
        ) {
          delete createPayload.storyPoints;
          wp = await client.createWorkPackage(createPayload);
          warnings.push({
            issueKey,
            message: `OpenProject từ chối ghi thuộc tính storyPoints; giá trị ${storyPoints} đã được bảo toàn trong Description.`,
          });
        } else {
          throw createErr;
        }
      }

      mapping[issueKey] = wp.id;
      existingWpByIssueKey.set(issueKey, wp);
      created++;
    } catch (error: any) {
      errors.push({
        issueKey,
        message: errorDetail(error),
      });
      skipped++;
    }
  }

  // ==========================================================
  // LƯỢT 2: Liên kết cha–con dựa trên Parent key
  // Không phụ thuộc thứ tự dòng trong CSV
  // ==========================================================
  for (const [issueKey, row] of issueKeyToRow) {
    const childId = mapping[issueKey];
    const parentKey = (row["Parent key"] ?? "").trim();

    if (!childId || !parentKey) continue;

    const parentId = mapping[parentKey];

    if (!parentId) {
      parentLinkErrors.push({
        issueKey,
        parentKey,
        message:
          "Không tìm thấy work package của Parent key. Issue cha có thể bị lỗi tạo, bị bỏ qua hoặc không có trong CSV.",
      });
      continue;
    }

    try {
      const current = await client.getWorkPackage(childId);

      // Nếu đã có quan hệ parent đúng với parentId này, bỏ qua để tránh API call thừa
      if (current._links?.parent?.href === `/api/v3/work_packages/${parentId}`) {
        parentLinksCreated++;
        continue;
      }

      await client.updateWorkPackage(childId, {
        parentId,
        lockVersion: current.lockVersion,
      });

      parentLinksCreated++;
    } catch (error: any) {
      parentLinkErrors.push({
        issueKey,
        parentKey,
        message: errorDetail(error),
      });
    }
  }

  return {
    projectId,
    projectIdentifier: project.identifier,
    projectName: project.name,
    mode,
    totalRows: records.length,
    createdWorkPackages: created,
    updatedWorkPackages: updated,
    skipped,
    parentLinksCreated,
    parentLinkErrors,
    errors,
    warnings,
    mapping,
  };
}
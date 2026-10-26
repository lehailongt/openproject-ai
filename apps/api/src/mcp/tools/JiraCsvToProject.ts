import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import fs from "node:fs/promises";
import path from "node:path";

import {
  jiraCsvToProject,
  parseCsv,
} from "../../openproject/jiraCsvToProject.js";

export function registerCsvTools(server: McpServer) {
  // ==========================================
  // TOOL 1: IMPORT JIRA CSV
  // ==========================================
  server.registerTool(
    "op_import_jira_csv",
    {
      description:
        "Import CSV Jira vào project OpenProject có sẵn bằng existingProjectId, " +
        "hoặc tạo project mới nếu không truyền ID. Nên chạy preview trước.",

      inputSchema: z
        .object({
          filePath: z
            .string()
            .min(1)
            .describe(
              "Đường dẫn tuyệt đối tới file CSV trên máy chạy MCP server.",
            ),

          existingProjectId: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "ID project OpenProject có sẵn. Ví dụ 4. " +
                "Nếu truyền trường này, chương trình không tạo project mới.",
            ),

          projectName: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Tên project mới; chỉ dùng khi không truyền existingProjectId.",
            ),

          projectIdentifier: z
            .string()
            .min(1)
            .regex(
              /^[a-z0-9-]+$/,
              "Chỉ chữ thường, số và gạch ngang.",
            )
            .optional()
            .describe(
              "Identifier project mới; chỉ dùng khi không truyền existingProjectId.",
            ),

          description: z.string().optional(),

          parentId: z.number().int().positive().optional(),

          public: z.boolean().default(false),

          mode: z
            .enum(["create_only", "upsert"])
            .default("create_only")
            .describe(
              "Chế độ xử lý trùng lặp theo Jira Issue Key: 'create_only' (mặc định, chỉ tạo issue chưa tồn tại, bỏ qua issue đã có), hoặc 'upsert' (tạo mới nếu chưa có, cập nhật nếu đã tồn tại).",
            ),

          userMapping: z
            .record(z.string(), z.number())
            .optional()
            .describe(
              "Bảng ánh xạ thủ công từ tên Jira Assignee hoặc Atlassian Account ID sang User ID của OpenProject. Ví dụ: { 'Vũ Trí Thuận': 4 }",
            ),
        })
        .refine(
          (input) =>
            input.existingProjectId !== undefined ||
            (!!input.projectName?.trim() &&
              !!input.projectIdentifier?.trim()),
          {
            message:
              "Truyền existingProjectId hoặc cả projectName và projectIdentifier.",
          },
        ),

      annotations: {
        destructiveHint: false,
      },
    },

    async (input) => {
      try {
        const cleanPath = input.filePath
          .replace(/^"|"$/g, "")
          .trim();

        const absolutePath = path.resolve(cleanPath);

        const csvContent = await fs.readFile(
          absolutePath,
          "utf8",
        );

        const report = await jiraCsvToProject({
          csvContent,
          existingProjectId: input.existingProjectId,
          projectName: input.projectName ?? "",
          projectIdentifier: input.projectIdentifier ?? "",
          description: input.description,
          parentId: input.parentId,
          public: input.public,
          mode: input.mode,
          userMapping: input.userMapping,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(report, null, 2),
            },
          ],
        };
      } catch (error: any) {
        const detail = error?.response?.data
          ? JSON.stringify(error.response.data, null, 2)
          : (error?.message ?? String(error));

        return {
          content: [
            {
              type: "text",
              text: `Lỗi Import: ${detail}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ==========================================
  // TOOL 2: PREVIEW JIRA CSV
  // Chỉ đọc dữ liệu, không tạo work package.
  // ==========================================
  server.registerTool(
    "op_preview_jira_csv",
    {
      description:
        "Đọc và phân tích CSV Jira, không ghi dữ liệu vào OpenProject. " +
        "Trả về tổng số dòng, loại issue, trạng thái và 3 dòng mẫu đầu tiên.",

      inputSchema: z.object({
        filePath: z
          .string()
          .min(1)
          .describe(
            "Đường dẫn tuyệt đối tới file CSV.",
          ),
      }),

      annotations: {
        readOnlyHint: true,
      },
    },

    async (input) => {
      try {
        const cleanPath = input.filePath
          .replace(/^"|"$/g, "")
          .trim();

        const csvContent = await fs.readFile(
          path.resolve(cleanPath),
          "utf8",
        );

        const records = parseCsv(csvContent);

        if (records.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "File CSV rỗng hoặc không đúng định dạng.",
              },
            ],
          };
        }

        const issueTypes: Record<string, number> = {};
        const statuses: Record<string, number> = {};

        for (const row of records) {
          const type = row["Issue Type"] || "(không rõ)";
          const status = row["Status"] || "(không rõ)";

          issueTypes[type] = (issueTypes[type] || 0) + 1;
          statuses[status] = (statuses[status] || 0) + 1;
        }

        const report = {
          totalRows: records.length,
          issueTypes,
          statuses,
          sampleFirst3Rows: records.slice(0, 3),
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(report, null, 2),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: `Lỗi đọc file: ${
                error?.message ?? String(error)
              }`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
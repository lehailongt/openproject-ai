import axios, { AxiosInstance, AxiosError } from "axios";
import { env } from "../config/env.js";

// ============================================================
// CẤU HÌNH
// ============================================================

export interface OpenProjectConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

// ============================================================
// INTERFACES — dữ liệu OpenProject trả về
// ============================================================

export interface WorkPackage {
  id: number;
  subject: string;
  description?: { raw?: string; html?: string };
  status: { href: string; title: string };
  type: { href: string; title: string };
  priority?: { href: string; title: string };
  assignee?: { href: string; title: string; name?: string };
  author?: { href: string; title: string; name?: string };
  project: { href: string; identifier: string; name: string };
  startDate?: string;
  dueDate?: string;
  estimatedTime?: string;
  spentTime?: string;
  percentageDone?: number;
  storyPoints?: number;
  lockVersion: number;
  _links?: Record<string, { href: string; title?: string }>;
}

export interface Project {
  id: number;
  identifier: string;
  name: string;
  description?: { raw?: string; html?: string };
  active: boolean;
  public: boolean;
  createdAt: string;
  updatedAt: string;
  status?: { href: string; title: string };
  parent?: { href: string; title: string };
  _links?: Record<string, { href: string; title?: string }>;
}

export interface Status {
  id: number;
  name: string;
  isDefault: boolean;
  isClosed: boolean;
  color: string;
  position: number;
}

export interface Type {
  id: number;
  name: string;
  color: string;
  position: number;
  isDefault: boolean;
  isMilestone: boolean;
}

export interface Priority {
  id: number;
  name: string;
  position: number;
  isDefault: boolean;
}

export interface User {
  id: number;
  name: string;
  login?: string;
  email?: string;
  avatar?: string;
  firstName?: string;
  lastName?: string;
}

export interface Version {
  id: number;
  name: string;
  description?: string;
  status: string;
  sharing: string;
  createdAt: string;
  updatedAt: string;
  startDate?: string;
  dueDate?: string;
}

export interface Membership {
  id: number;
  _links: {
    user: { href: string; title: string };
    project: { href: string; title: string };
    role: { href: string; title: string }[];
  };
}

export interface Activity {
  id: number;
  type: string;
  createdAt: string;
  user: { href: string; title: string };
  description: string;
  details: { format: string; raw: string; html: string }[];
  htmlMessage?: string;
}

export interface Relation {
  id: number;
  type: string;
  _links: {
    self: { href: string };
    workPackageFrom: { href: string; title: string };
    workPackageTo: { href: string; title: string };
  };
}

export interface HalCollection<T> {
  _embedded: { elements: T[] };
  total: number;
  count: number;
  pageSize: number;
  offset: number;
}

// ============================================================
// CLIENT CLASS
// ============================================================

export class OpenProjectClient {
  private http: AxiosInstance;

  constructor(config: OpenProjectConfig) {
    // Basic Auth: "apikey:<API_TOKEN>" encoded base64
    const credentials = Buffer.from(`apikey:${config.apiKey}`).toString(
      "base64",
    );

    this.http = axios.create({
      baseURL: config.baseUrl.replace(/\/+$/, ""), // bỏ trailing slash
      timeout: config.timeoutMs ?? 30_000,
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });

    // Log lỗi ra stderr (không phải stdout) để debug
    this.http.interceptors.response.use(
      (res) => res,
      (err: AxiosError) => {
        const status = err.response?.status;
        const data = err.response?.data as Record<string, unknown> | undefined;
        console.error(
          `[OpenProjectClient] HTTP ${status ?? "ERR"} ${err.config?.method?.toUpperCase()} ${err.config?.url}` +
            (data ? ` → ${JSON.stringify(data)}` : ""),
        );
        return Promise.reject(err);
      },
    );
  }

  // ==================== PROJECTS ====================

  async listProjects(params?: {
    page?: number;
    perPage?: number;
    filters?: string;
    sortBy?: string;
  }): Promise<HalCollection<Project>> {
    const { data } = await this.http.get<HalCollection<Project>>(
      "/api/v3/projects",
      {
        params: {
          page: params?.page,
          pageSize: params?.perPage,
          filters: params?.filters,
          sortBy: params?.sortBy,
        },
      },
    );
    return data;
  }

  async getProject(projectId: number | string): Promise<Project> {
    const { data } = await this.http.get<Project>(
      `/api/v3/projects/${projectId}`,
    );
    return data;
  }

  async createProject(input: {
    name: string;
    identifier: string;
    description?: string;
    parentId?: number;
    active?: boolean;
    public?: boolean;
  }): Promise<Project> {
    const payload: Record<string, unknown> = {
      name: input.name,
      identifier: input.identifier,
      active: input.active ?? true,
      public: input.public ?? false,
    };
    if (input.description) payload.description = { raw: input.description };
    if (input.parentId)
      payload._links = {
        parent: { href: `/api/v3/projects/${input.parentId}` },
      };

    const { data } = await this.http.post<Project>("/api/v3/projects", payload);
    return data;
  }

  async updateProject(
    projectId: number | string,
    input: Partial<{
      name: string;
      description: string;
      active: boolean;
      public: boolean;
      status: string;
    }>,
  ): Promise<Project> {
    const payload: Record<string, unknown> = {};
    if (input.name !== undefined) payload.name = input.name;
    if (input.description !== undefined)
      payload.description = { raw: input.description };
    if (input.active !== undefined) payload.active = input.active;
    if (input.public !== undefined) payload.public = input.public;
    if (input.status !== undefined) payload.status = input.status;

    const { data } = await this.http.patch<Project>(
      `/api/v3/projects/${projectId}`,
      payload,
    );
    return data;
  }

  async deleteProject(projectId: number | string): Promise<void> {
    await this.http.delete(`/api/v3/projects/${projectId}`);
  }

  // ==================== PROJECT MEMBERS & VERSIONS ====================

  async listProjectMembers(
    projectId: number | string,
  ): Promise<HalCollection<Membership>> {
    const { data } = await this.http.get<HalCollection<Membership>>(
      `/api/v3/projects/${projectId}/memberships`,
    );
    return data;
  }

  async addProjectMember(
    projectId: number | string,
    userId: number,
    roleIds: number[],
  ): Promise<Membership> {
    const { data } = await this.http.post<Membership>(
      "/api/v3/memberships", // Endpoint đúng
      {
        _links: {
          project: { href: `/api/v3/projects/${projectId}` },
          principal: { href: `/api/v3/users/${userId}` },
          roles: roleIds.map((id) => ({ href: `/api/v3/roles/${id}` })),
        },
      },
    );
    return data;
  }

  async removeProjectMember(
    projectId: number | string,
    membershipId: number,
  ): Promise<void> {
    await this.http.delete(
      `/api/v3/projects/${projectId}/memberships/${membershipId}`,
    );
  }

  async listProjectVersions(
    projectId: number | string,
  ): Promise<HalCollection<Version>> {
    const { data } = await this.http.get<HalCollection<Version>>(
      `/api/v3/projects/${projectId}/versions`,
    );
    return data;
  }

  async createVersion(
    projectId: number | string,
    input: {
      name: string;
      description?: string;
      status?: string;
      startDate?: string;
      dueDate?: string;
    },
  ): Promise<Version> {
    const { data } = await this.http.post<Version>(
      `/api/v3/projects/${projectId}/versions`,
      input,
    );
    return data;
  }

  // ==================== WORK PACKAGES ====================

  async listWorkPackages(params?: {
    projectId?: number | string;
    filters?: string;
    page?: number;
    perPage?: number;
    sortBy?: string;
  }): Promise<HalCollection<WorkPackage>> {
    const { data } = await this.http.get<HalCollection<WorkPackage>>(
      "/api/v3/work_packages",
      {
        params: {
          projectId: params?.projectId,
          filters: params?.filters,
          page: params?.page,
          pageSize: params?.perPage,
          sortBy: params?.sortBy,
        },
      },
    );
    return data;
  }

  async getWorkPackage(workPackageId: number): Promise<WorkPackage> {
    const { data } = await this.http.get<WorkPackage>(
      `/api/v3/work_packages/${workPackageId}`,
    );
    return data;
  }

  async getWorkPackageSchema(
    projectId: number | string,
    typeId: number | string,
  ): Promise<any> {
    const { data } = await this.http.get(
      `/api/v3/work_packages/schemas/${projectId}-${typeId}`,
    );
    return data;
  }

  async createWorkPackage(input: {
    subject: string;
    description?: string;
    projectId: number | string;
    typeId?: number;
    statusId?: number;
    priorityId?: number;
    assigneeId?: number;
    startDate?: string;
    dueDate?: string;
    estimatedTime?: string;
    storyPoints?: number;
    parentId?: number;
    versionId?: number;
  }): Promise<WorkPackage> {
    const links: Record<string, { href: string }> = {
      project: { href: `/api/v3/projects/${input.projectId}` },
    };
    if (input.typeId) links.type = { href: `/api/v3/types/${input.typeId}` };
    if (input.statusId)
      links.status = { href: `/api/v3/statuses/${input.statusId}` };
    if (input.priorityId)
      links.priority = { href: `/api/v3/priorities/${input.priorityId}` };
    if (input.assigneeId)
      links.assignee = { href: `/api/v3/users/${input.assigneeId}` };
    if (input.parentId)
      links.parent = { href: `/api/v3/work_packages/${input.parentId}` };
    if (input.versionId)
      links.version = { href: `/api/v3/versions/${input.versionId}` };

    const payload: Record<string, unknown> = {
      subject: input.subject,
      _links: links,
    };
    if (input.description) payload.description = { raw: input.description };
    if (input.startDate) payload.startDate = input.startDate;
    if (input.dueDate) payload.dueDate = input.dueDate;
    if (input.estimatedTime) payload.estimatedTime = input.estimatedTime;
    if (input.storyPoints !== undefined) payload.storyPoints = input.storyPoints;

    const { data } = await this.http.post<WorkPackage>(
      "/api/v3/work_packages",
      payload,
    );
    return data;
  }

  async updateWorkPackage(
    workPackageId: number,
    input: Partial<{
      subject: string;
      description: string;
      statusId: number;
      typeId: number;
      priorityId: number;
      assigneeId: number;
      startDate: string;
      dueDate: string;
      estimatedTime: string;
      storyPoints: number;
      percentageDone: number;
      parentId: number;
      versionId: number;
      lockVersion: number;
    }>,
  ): Promise<WorkPackage> {
    const payload: Record<string, unknown> = {};
    const links: Record<string, { href: string }> = {};

    if (input.subject !== undefined) payload.subject = input.subject;
    if (input.description !== undefined)
      payload.description = { raw: input.description };
    if (input.statusId !== undefined)
      links.status = { href: `/api/v3/statuses/${input.statusId}` };
    if (input.typeId !== undefined)
      links.type = { href: `/api/v3/types/${input.typeId}` };
    if (input.priorityId !== undefined)
      links.priority = { href: `/api/v3/priorities/${input.priorityId}` };
    if (input.assigneeId !== undefined)
      links.assignee = { href: `/api/v3/users/${input.assigneeId}` };
    if (input.parentId !== undefined)
      links.parent = { href: `/api/v3/work_packages/${input.parentId}` };
    if (input.versionId !== undefined)
      links.version = { href: `/api/v3/versions/${input.versionId}` };

    if (input.startDate !== undefined) payload.startDate = input.startDate;
    if (input.dueDate !== undefined) payload.dueDate = input.dueDate;
    if (input.estimatedTime !== undefined)
      payload.estimatedTime = input.estimatedTime;
    if (input.storyPoints !== undefined)
      payload.storyPoints = input.storyPoints;
    if (input.percentageDone !== undefined)
      payload.percentageDone = input.percentageDone;
    if (input.lockVersion !== undefined)
      payload.lockVersion = input.lockVersion;

    if (Object.keys(links).length > 0) payload._links = links;

    const { data } = await this.http.patch<WorkPackage>(
      `/api/v3/work_packages/${workPackageId}`,
      payload,
    );
    return data;
  }

  async deleteWorkPackage(workPackageId: number): Promise<void> {
    await this.http.delete(`/api/v3/work_packages/${workPackageId}`);
  }

  async listWorkPackageActivities(
    workPackageId: number,
  ): Promise<HalCollection<Activity>> {
    const { data } = await this.http.get<HalCollection<Activity>>(
      `/api/v3/work_packages/${workPackageId}/activities`,
    );
    return data;
  }

  async addWorkPackageComment(
    workPackageId: number,
    comment: string,
  ): Promise<Activity> {
    const { data } = await this.http.post<Activity>(
      `/api/v3/work_packages/${workPackageId}/activities`,
      { comment: { raw: comment } },
    );
    return data;
  }

  async listWorkPackageRelations(
    workPackageId: number,
  ): Promise<HalCollection<Relation>> {
    const { data } = await this.http.get<HalCollection<Relation>>(
      `/api/v3/work_packages/${workPackageId}/relations`,
    );
    return data;
  }

  async createWorkPackageRelation(
    workPackageId: number,
    input: { type: string; workPackageIdTo: number },
  ): Promise<Relation> {
    const { data } = await this.http.post<Relation>(
      `/api/v3/work_packages/${workPackageId}/relations`,
      {
        type: input.type,
        _links: {
          to: { href: `/api/v3/work_packages/${input.workPackageIdTo}` },
        },
      },
    );
    return data;
  }

  async deleteWorkPackageRelation(
    workPackageId: number,
    relationId: number,
  ): Promise<void> {
    await this.http.delete(
      `/api/v3/work_packages/${workPackageId}/relations/${relationId}`,
    );
  }

  async getProjectWorkPackages(
    projectId: number | string,
  ): Promise<HalCollection<WorkPackage>> {
    const { data } = await this.http.get<HalCollection<WorkPackage>>(
      `/api/v3/projects/${projectId}/work_packages`,
    );
    return data;
  }

  // ==================== CATALOG ====================

  async listStatuses(): Promise<HalCollection<Status>> {
    const { data } =
      await this.http.get<HalCollection<Status>>("/api/v3/statuses");
    return data;
  }

  async listTypes(): Promise<HalCollection<Type>> {
    const { data } = await this.http.get<HalCollection<Type>>("/api/v3/types");
    return data;
  }

  async getProjectTypes(
    projectId: number | string,
  ): Promise<HalCollection<Type>> {
    const { data } = await this.http.get<HalCollection<Type>>(
      `/api/v3/projects/${projectId}/types`,
    );
    return data;
  }

  async listPriorities(): Promise<HalCollection<Priority>> {
    const { data } =
      await this.http.get<HalCollection<Priority>>("/api/v3/priorities");
    return data;
  }

  // ==================== USERS ====================

  async listUsers(params?: {
    page?: number;
    perPage?: number;
    filters?: string;
  }): Promise<HalCollection<User>> {
    const { data } = await this.http.get<HalCollection<User>>("/api/v3/users", {
      params: {
        page: params?.page,
        pageSize: params?.perPage,
        filters: params?.filters,
      },
    });
    return data;
  }

  async getUser(userId: number): Promise<User> {
    const { data } = await this.http.get<User>(`/api/v3/users/${userId}`);
    return data;
  }

  async getCurrentUser(): Promise<User> {
    const { data } = await this.http.get<User>("/api/v3/users/me");
    return data;
  }

  async listProjectAvailableAssignees(
    projectId: number | string,
  ): Promise<HalCollection<User>> {
    const { data } = await this.http.get<HalCollection<User>>(
      `/api/v3/projects/${projectId}/available_assignees`,
    );
    return data;
  }

  // ==================== ROLES & GROUPS ====================

  async listRoles(): Promise<HalCollection<{ id: number; name: string }>> {
    const { data } =
      await this.http.get<HalCollection<{ id: number; name: string }>>(
        "/api/v3/roles",
      );
    return data;
  }

  async listGroups(): Promise<HalCollection<{ id: number; name: string }>> {
    const { data } =
      await this.http.get<HalCollection<{ id: number; name: string }>>(
        "/api/v3/groups",
      );
    return data;
  }

  // ==================== SEARCH ====================

  async search(
    query: string,
    params?: {
      projectId?: number | string;
      typeId?: number;
      statusId?: number;
    },
  ): Promise<HalCollection<WorkPackage>> {
    const filters: unknown[] = [];
    // OpenProject search dùng filter "search" cho subject
    filters.push({ search: { operator: "**", values: [query] } });
    if (params?.projectId)
      filters.push({
        project: { operator: "=", values: [String(params.projectId)] },
      });
    if (params?.typeId)
      filters.push({
        type: { operator: "=", values: [String(params.typeId)] },
      });
    if (params?.statusId)
      filters.push({
        status: { operator: "=", values: [String(params.statusId)] },
      });

    const { data } = await this.http.get<HalCollection<WorkPackage>>(
      "/api/v3/work_packages",
      {
        params: { filters: JSON.stringify(filters) },
      },
    );
    return data;
  }

  // ==================== TYPES (WORK PACKAGE TYPES) ====================
  // Thêm 2 hàm này vào trong class OpenProjectClient (file client.ts)

  async addTypeToProject(
    projectId: number | string,
    typeId: number,
  ): Promise<void> {
    await this.http.patch(`/api/v3/projects/${projectId}/types`, {
      _links: {
        added: [{ href: `/api/v3/types/${typeId}` }],
      },
    });
  }

  async createSystemType(typeName: string): Promise<any> {
    const { data } = await this.http.post(`/api/v3/types`, {
      name: typeName,
      color: "#1A67A3",
      isMilestone: typeName.toLowerCase() === "epic",
    });
    return data;
  }
}

// ============================================================
// SINGLETON — dùng chung cho toàn bộ MCP server
// ============================================================

const BASE_URL = env.openprojectUrl ?? "http://localhost:8080";
const API_TOKEN = env.openprojectToken ?? "";

if (!API_TOKEN) {
  console.error(
    "[OpenProjectClient] CẢNH BÁO: OPENPROJECT_API_TOKEN chưa được set",
  );
}

export const client = new OpenProjectClient({
  baseUrl: BASE_URL,
  apiKey: API_TOKEN,
});

console.error(`[OpenProjectClient] Khởi tạo với baseUrl=${BASE_URL}`);

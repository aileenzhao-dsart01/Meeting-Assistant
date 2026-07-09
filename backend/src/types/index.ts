// ---------- Meeting ----------
export type MeetingStatus =
  | "pending"
  | "uploading"
  | "transcribing"
  | "summarizing"
  | "complete"
  | "error";

// ---------- API ----------
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface MeetingListItem {
  id: string;
  title: string;
  date: string;
  duration: number | null;
  status: MeetingStatus;
  taskCount: number;
}

export interface MeetingDetail {
  id: string;
  title: string;
  date: string;
  duration: number | null;
  status: MeetingStatus;
  recordingUrl: string | null;
  transcript: string | null;
  summary: string | null;
  bulletPoints: string[] | null;
  topics: string[] | null;
  error: string | null;
  tasks: TaskItem[];
  createdAt: string;
  updatedAt: string;
  /**
   * @deprecated Use workspace-scoped routes instead.
   * Present only on legacy flat-route responses for backward compatibility.
   */
  workspaceId?: string;
}

export interface TaskItem {
  id: string;
  description: string;
  assignee?: string;
  status: string;
  priority?: string;
}

// ---------- Auth & Workspaces ----------
export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
}

export interface AuthWorkspace {
  id: string;
  name: string;
  slug: string;
  role: string;
}

export interface WorkspaceResponse {
  id: string;
  name: string;
  slug: string;
  role: string;
  memberCount: number;
  createdAt: string;
}

export interface MemberResponse {
  id: string;
  userId: string;
  email: string;
  name: string | null;
  role: string;
  joinedAt: string;
}

export interface JwtPayload {
  userId: string;
  email: string;
}

/** Role hierarchy: owner > admin > member */
export type WorkspaceRole = "owner" | "admin" | "member";

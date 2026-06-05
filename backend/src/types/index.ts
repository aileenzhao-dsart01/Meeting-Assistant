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
}

export interface TaskItem {
  id: string;
  description: string;
  assignee?: string;
  status: string;
  priority?: string;
}

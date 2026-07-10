import { WorkspaceRole } from "./index";

declare global {
  namespace Express {
    interface Request {
      /** Authenticated user info — set by auth middleware from Supabase JWT. */
      user?: {
        id: string;   // Supabase user UUID (sub claim)
        email: string;
      };
      /** Workspace context — set by workspace membership middleware. */
      workspace?: {
        id: string;
        role: WorkspaceRole;
      };
    }
  }
}

export {};

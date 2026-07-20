import { openAsBlob } from "fs";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { config } from "../../config";
import { StorageProvider } from "./interface";

const DEFAULT_BUCKET = "meeting-audio";

/**
 * Supabase Storage provider.
 * Files persist across deploys — ideal for Render / cloud deployments.
 * Bucket must be created first in Supabase dashboard (public read access).
 *
 * Large files (>6MB) are uploaded via TUS resumable upload protocol,
 * bypassing the 10MB API gateway limit that would otherwise cause a 413 error.
 */
export class SupabaseStorageProvider implements StorageProvider {
  readonly name = "supabase";
  private bucket: string;
  private supabase: SupabaseClient;

  constructor() {
    this.bucket = config.storage.supabase.bucket || DEFAULT_BUCKET;
    this.supabase = createClient(config.storage.supabase.url, config.storage.supabase.serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });
  }

  private get baseUrl(): string {
    const projectUrl = config.storage.supabase.url.replace(/\/$/, "");
    return `${projectUrl}/storage/v1/object/${this.bucket}`;
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${config.storage.supabase.serviceRoleKey}`,
      apikey: config.storage.supabase.serviceRoleKey,
    };
  }

  async save(filename: string, filePath: string, mimeType: string): Promise<string> {
    // Use the Supabase JS SDK which auto-switches to TUS resumable upload
    // for files >= 6MB — this bypasses the API gateway's 10MB request body limit.
    // openAsBlob() creates a file-backed Blob (no in-memory copy).
    const fileBlob = await openAsBlob(filePath);
    const { error } = await this.supabase.storage.from(this.bucket).upload(filename, fileBlob, {
      contentType: mimeType,
      upsert: true,
      cacheControl: "3600",
    });

    if (error) {
      throw new Error(`Supabase Storage upload failed: ${error.message}`);
    }

    return filename;
  }

  async read(filename: string): Promise<Buffer | null> {
    const resp = await fetch(`${this.baseUrl}/${filename}`, {
      headers: this.headers,
    });

    if (resp.status === 404) return null;
    if (!resp.ok) {
      throw new Error(
        `Supabase Storage read failed (${resp.status}): ${(await resp.text()).substring(0, 200)}`
      );
    }

    const arrayBuf = await resp.arrayBuffer();
    return Buffer.from(arrayBuf);
  }

  async delete(filename: string): Promise<boolean> {
    const resp = await fetch(`${this.baseUrl}/${filename}`, {
      method: "DELETE",
      headers: this.headers,
    });

    if (resp.status === 404) return false;
    if (!resp.ok) {
      throw new Error(
        `Supabase Storage delete failed (${resp.status}): ${(await resp.text()).substring(0, 200)}`
      );
    }
    return true;
  }

  async exists(filename: string): Promise<boolean> {
    // Supabase Storage doesn't have a HEAD endpoint, so just try reading
    const result = await this.read(filename);
    return result !== null;
  }

  /**
   * Public URL for direct browser streaming.
   * No auth needed — the bucket should be set to public in Supabase dashboard.
   */
  getPublicUrl(filename: string): string | null {
    return `${this.baseUrl}/${filename}`;
  }
}

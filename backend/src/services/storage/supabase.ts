import { config } from "../../config";
import { StorageProvider } from "./interface";

const DEFAULT_BUCKET = "meeting-audio";

/**
 * Supabase Storage provider.
 * Files persist across deploys — ideal for Render / cloud deployments.
 * Bucket must be created first in Supabase dashboard (public read access).
 */
export class SupabaseStorageProvider implements StorageProvider {
  readonly name = "supabase";
  private bucket: string;

  constructor() {
    this.bucket = config.storage.supabase.bucket || DEFAULT_BUCKET;
  }

  private get baseUrl(): string {
    const projectUrl = config.storage.supabase.url.replace(/\/$/, "");
    return `${projectUrl}/storage/v1/object/${this.bucket}`;
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${config.storage.supabase.serviceRoleKey}`,
      apiKey: config.storage.supabase.serviceRoleKey,
    };
  }

  async save(filename: string, data: Buffer, mimeType: string): Promise<string> {
    const resp = await fetch(`${this.baseUrl}/${filename}`, {
      method: "POST",
      headers: {
        ...this.headers,
        "Content-Type": mimeType,
        "x-upsert": "true",
      },
      body: data,
    });

    if (!resp.ok) {
      const err = await resp.text().catch(() => "unknown");
      throw new Error(`Supabase Storage upload failed (${resp.status}): ${err.substring(0, 300)}`);
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

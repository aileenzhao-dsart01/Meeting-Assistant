import fs from "fs";
import http from "http";
import https from "https";
import { Readable } from "stream";
import { config } from "../../config";
import { StorageProvider, StoredStream } from "./interface";

const DEFAULT_BUCKET = "meeting-audio";

/**
 * Supabase Storage provider.
 * Files persist across deploys — ideal for Render / cloud deployments.
 * Bucket must be created first in Supabase dashboard (public read access).
 *
 * Uploads stream the file body directly to the Storage REST API via
 * http/https (not the supabase-js SDK). The SDK wraps file Blobs in FormData,
 * which undici buffers entirely in RAM — a 300MB upload spikes memory by
 * ~300MB and OOM-kills a 512MB Render instance. Streaming keeps RAM flat.
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
      apikey: config.storage.supabase.serviceRoleKey,
    };
  }

  async save(filename: string, filePath: string, mimeType: string): Promise<string> {
    const size = fs.statSync(filePath).size;
    const url = `${this.baseUrl}/${filename}`;

    // Stream the file from disk to Supabase — no in-memory copy.
    // http.ClientRequest is a Writable; pipe() handles backpressure.
    const resp = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const parsed = new URL(url);
      const mod = parsed.protocol === "https:" ? https : http;
      const req = mod.request(
        parsed,
        {
          method: "POST",
          headers: {
            ...this.headers,
            "Content-Type": mimeType,
            "Content-Length": String(size),
            "Cache-Control": "max-age=3600",
            "x-upsert": "true",
          },
        },
        (res) => resolve(res)
      );
      req.on("error", reject);
      fs.createReadStream(filePath).pipe(req);
    });

    if (resp.statusCode !== 200 && resp.statusCode !== 201) {
      const chunks: Buffer[] = [];
      for await (const chunk of resp) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8").substring(0, 300);
      throw new Error(`Supabase Storage upload failed (${resp.statusCode}): ${body}`);
    }
    resp.resume(); // drain the response body

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

  async readStream(key: string, signal?: AbortSignal): Promise<StoredStream | null> {
    const resp = await fetch(`${this.baseUrl}/${key}`, {
      headers: this.headers,
      signal,
    });

    if (resp.status === 404) return null;
    if (!resp.ok) {
      throw new Error(
        `Supabase Storage read failed (${resp.status}): ${(await resp.text()).substring(0, 200)}`
      );
    }

    const size = Number(resp.headers.get("content-length") || 0);
    const stream = resp.body
      ? Readable.fromWeb(resp.body as any)
      : Readable.from([]);
    return { stream, size };
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
    // Request only the first byte instead of downloading the whole file.
    // (read() — which buffers the entire audio into RAM — used to OOM a 512MB
    // Render instance when the process route checked existence of a large file.)
    const resp = await fetch(`${this.baseUrl}/${filename}`, {
      headers: { ...this.headers, Range: "bytes=0-0" },
    });

    if (resp.status === 404) return false;
    if (resp.status === 200 || resp.status === 206 || resp.status === 416) return true;
    // Any other non-2xx status — treat as "can't confirm" but don't throw
    return resp.ok;
  }

  /**
   * Public URL for direct browser streaming.
   * No auth needed — the bucket should be set to public in Supabase dashboard.
   */
  getPublicUrl(filename: string): string | null {
    return `${this.baseUrl}/${filename}`;
  }
}

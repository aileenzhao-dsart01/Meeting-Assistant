import fs from "fs";
import path from "path";
import { config } from "../../config";
import { StorageProvider } from "./interface";

/**
 * Local disk storage provider.
 * Files are stored under the configured AUDIO_STORAGE_PATH directory.
 * Works everywhere, but files are lost on Render when the service restarts.
 */
export class LocalStorageProvider implements StorageProvider {
  readonly name = "local";

  private get basePath(): string {
    return config.audio.storagePath;
  }

  private fullPath(filename: string): string {
    return path.resolve(this.basePath, filename);
  }

  async save(filename: string, data: Buffer, _mimeType: string): Promise<string> {
    if (!fs.existsSync(this.basePath)) {
      fs.mkdirSync(this.basePath, { recursive: true });
    }
    const fp = this.fullPath(filename);
    fs.writeFileSync(fp, data);
    return filename;
  }

  async read(filename: string): Promise<Buffer | null> {
    const fp = this.fullPath(filename);
    if (!fs.existsSync(fp)) return null;
    return fs.readFileSync(fp);
  }

  async delete(filename: string): Promise<boolean> {
    const fp = this.fullPath(filename);
    if (!fs.existsSync(fp)) return false;
    fs.unlinkSync(fp);
    return true;
  }

  async exists(filename: string): Promise<boolean> {
    return fs.existsSync(this.fullPath(filename));
  }

  getPublicUrl(filename: string): string | null {
    return null; // Local storage serves files via the API endpoint
  }
}

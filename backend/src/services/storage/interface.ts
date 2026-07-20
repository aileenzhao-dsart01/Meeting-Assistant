/**
 * Storage Provider Interface
 *
 * Abstracts file storage behind a common contract.
 * Currently supports local disk and Supabase Storage.
 */

export interface StorageProvider {
  readonly name: string;

  /** Save a file from a local path. Returns the filename (key) used to store it. */
  save(filename: string, filePath: string, mimeType: string): Promise<string>;

  /** Read a file. Returns the data buffer, or null if not found. */
  read(filename: string): Promise<Buffer | null>;

  /** Delete a file. Returns true if deleted, false if not found. */
  delete(filename: string): Promise<boolean>;

  /** Check if a file exists. */
  exists(filename: string): Promise<boolean>;

  /** Get the public URL for a file (for downloading). Null if local storage. */
  getPublicUrl(filename: string): string | null;
}

import { config } from "../../config";
import { StorageProvider } from "./interface";
import { LocalStorageProvider } from "./local";
import { SupabaseStorageProvider } from "./supabase";

let provider: StorageProvider | null = null;

/**
 * Get or create the configured storage provider.
 * Lazily initialized so config is ready when first called.
 */
export function getStorageProvider(): StorageProvider {
  if (!provider) {
    switch (config.storage.provider) {
      case "supabase":
        provider = new SupabaseStorageProvider();
        break;
      case "local":
      default:
        provider = new LocalStorageProvider();
        break;
    }
  }
  return provider;
}

/**
 * Reset the provider (useful for tests or config changes).
 */
export function resetStorageProvider(): void {
  provider = null;
}

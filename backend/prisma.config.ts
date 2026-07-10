import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { defineConfig, env } from "@prisma/config";

// Load .env if it exists (for local dev; Render uses env vars directly)
const envPath = path.resolve(__dirname, ".env");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

export default defineConfig({
  schema: "./prisma/schema.prisma",
  datasource: {
    url: env("DATABASE_URL"),
  },
  migrations: {
    seed: "tsx prisma/seed.ts",
  },
});

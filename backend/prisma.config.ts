import dotenv from "dotenv";
import path from "path";
import { defineConfig, env } from "@prisma/config";

// Load .env so DATABASE_URL is available for Prisma CLI commands
dotenv.config({ path: path.resolve(__dirname, ".env") });

export default defineConfig({
  schema: "./prisma/schema.prisma",
  datasource: {
    url: env("DATABASE_URL"),
  },
});

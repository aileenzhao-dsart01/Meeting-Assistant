import dotenv from "dotenv";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set in .env");

const adapter = new PrismaPg(databaseUrl);
const prisma = new PrismaClient({ adapter });

async function main() {
  // Idempotent: skip if default workspace already exists
  const existingDefault = await prisma.workspace.findUnique({
    where: { slug: "default-workspace" },
  });
  if (existingDefault) {
    console.log("Default workspace already exists — skipping seed.");
    return;
  }

  // Create default workspace (no admin user — auth is through Supabase)
  const defaultWorkspace = await prisma.workspace.create({
    data: {
      name: "Default Workspace",
      slug: "default-workspace",
    },
  });
  console.log(" Default workspace created:", defaultWorkspace.name);

  // Assign all existing orphan meetings to the default workspace
  // Also set createdBy for meetings with the placeholder UUID
  const orphanCount = await prisma.meeting.count({
    where: { workspaceId: null },
  });

  if (orphanCount > 0) {
    await prisma.meeting.updateMany({
      where: { workspaceId: null },
      data: {
        workspaceId: defaultWorkspace.id,
        createdBy: "00000000-0000-0000-0000-000000000000",
      },
    });
    console.log(` Assigned ${orphanCount} existing meetings to default workspace`);
  }

  // Also set createdBy for any meetings that still have the old placeholder
  const unsetCreator = await prisma.meeting.count({
    where: { createdBy: null },
  });
  if (unsetCreator > 0) {
    await prisma.meeting.updateMany({
      where: { createdBy: null },
      data: { createdBy: "00000000-0000-0000-0000-000000000000" },
    });
    console.log(` Set createdBy on ${unsetCreator} meetings`);
  }

  console.log("Seed completed successfully!");
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

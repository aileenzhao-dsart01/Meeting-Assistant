import dotenv from "dotenv";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";

// Load .env so PrismaClient can find DATABASE_URL
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set in .env");
}

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

  // 1. Create admin user (if not exists)
  const adminEmail = "admin@meeting-assistant.local";
  let adminUser = await prisma.user.findUnique({ where: { email: adminEmail } });

  if (!adminUser) {
    adminUser = await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash: await bcrypt.hash("admin123", 12),
        name: "Admin",
      },
    });
    console.log("✓ Admin user created:", adminUser.email);
  } else {
    console.log("Admin user already exists");
  }

  // 2. Create default workspace
  const defaultWorkspace = await prisma.workspace.create({
    data: {
      name: "Default Workspace",
      slug: "default-workspace",
      members: {
        create: { userId: adminUser.id, role: "owner" },
      },
    },
  });
  console.log("✓ Default workspace created:", defaultWorkspace.name);

  // 3. Assign all existing orphan meetings to the default workspace
  const orphanCount = await prisma.meeting.count({
    where: { workspaceId: null },
  });

  if (orphanCount > 0) {
    await prisma.meeting.updateMany({
      where: { workspaceId: null },
      data: { workspaceId: defaultWorkspace.id },
    });
    console.log(`✓ Assigned ${orphanCount} existing meetings to default workspace`);
  } else {
    console.log("No orphan meetings to assign");
  }

  console.log("Seed completed successfully!");
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

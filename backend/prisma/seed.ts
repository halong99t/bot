import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Tạo settings mặc định nếu chưa có
  const existing = await prisma.settings.findFirst();
  if (!existing) {
    await prisma.settings.create({
      data: {
        takeProfitPct: 90,
        stopLossPct: 50,
        orderSizeUsdt: 50,
        leverage: 5,
        scanIntervalMs: 60000,
        autoTrade: false,
      },
    });
    console.log("✓ Default settings created");
  } else {
    console.log("• Settings already exist, skipping");
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });

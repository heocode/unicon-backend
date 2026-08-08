import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
});

const prisma = new PrismaClient({ adapter });

async function main() {
  const university = await prisma.university.upsert({
    where: {
      name: 'Centennial College',
    },
    update: {},
    create: {
      name: 'Centennial College',
    },
  });

  const domains = ['my.centennialcollege.ca', 'gmail.com'];

  for (const domain of domains) {
    await prisma.allowedDomain.upsert({
      where: {
        domain,
      },
      update: {
        active: true,
        universityId: university.id,
      },
      create: {
        domain,
        universityId: university.id,
      },
    });
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

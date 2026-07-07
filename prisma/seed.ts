import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
});

export const prisma = new PrismaClient({ adapter });

const universities = [
  // 1
  {
    name: 'Centennial College',
    domains: ['my.centennialcollege.ca'],
    users: [
      {
        email: 'vadim@my.centennialcollege.ca',
        username: 'heoposit',
        password: 'password1234',
      },
      {
        email: 'nikita@my.centennialcollege.ca',
        username: 'soulbind',
        password: 'password1234',
      },
    ],
  },
  // 2
  {
    name: 'Seneca Polytech',
    domains: ['my.senecapolytech.ca'],
    users: [
      {
        email: 'iliya@my.senecapolytech.ca',
        username: 'iliya',
        password: 'password1234',
      },
      {
        email: 'zhenya@my.senecapolytech.ca',
        username: 'zhenya',
        password: 'password1234',
      },
    ],
  },
  // 3
  {
    name: 'Humbler College',
    domains: ['my.humblercollege.ca'],
    users: [
      {
        email: 'veronika@my.humblercollege.ca',
        username: 'veronika',
        password: 'password1234',
      },
      {
        email: 'rinat@my.humblercollege.ca',
        username: 'rinat',
        password: 'password1234',
      },
    ],
  },
];

async function main() {
  for (const university of universities) {
    const createdUniversity = await prisma.university.create({
      data: {
        name: university.name,
      },
    });

    for (const user of university.users) {
      await prisma.user.create({
        data: {
          email: user.email,
          username: user.username,
          passwordHash: user.password,
          universityId: createdUniversity.id,
        },
      });
    }

    for (const domain of university.domains) {
      await prisma.allowedDomain.create({
        data: {
          domain: domain,
          universityId: createdUniversity.id,
        },
      });
    }
  }
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });

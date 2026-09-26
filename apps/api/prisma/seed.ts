import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

async function main() {
  const employeePassword = process.env.SEED_EMPLOYEE_PASSWORD;

  if (!employeePassword) {
    throw new Error('SEED_EMPLOYEE_PASSWORD is required');
  }

  const passwordHash = await argon2.hash(employeePassword);

  const employee = await prisma.employee.upsert({
    where: { employeeId: '1000001' },
    update: {
      name: 'Demo Employee',
      passwordHash,
      active: true,
      role: 'EMPLOYEE',
    },
    create: {
      employeeId: '1000001',
      name: 'Demo Employee',
      passwordHash,
      role: 'EMPLOYEE',
    },
  });

  const hrPassword = process.env.SEED_HR_PASSWORD;

  if (!hrPassword) {
    throw new Error('SEED_HR_PASSWORD is required');
  }

  const hrPasswordHash = await argon2.hash(hrPassword);

  await prisma.employee.upsert({
    where: { employeeId: '9000001' },
    update: {
      name: 'Demo HR',
      passwordHash: hrPasswordHash,
      active: true,
      role: 'HR',
    },
    create: {
      employeeId: '9000001',
      name: 'Demo HR',
      passwordHash: hrPasswordHash,
      role: 'HR',
    },
  });

  await prisma.office.upsert({
    where: { id: '00000000-0000-0000-0000-000000000001' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000001',
      name: 'Demo Office',
      // Replace these fictional/demo coordinates before deployment.
      latitude: 5.6037,
      longitude: -0.1870,
      radiusMeters: 100,
      maxGpsAccuracyMeters: 100,
      maxLocationAgeSeconds: 120,
    },
  });

  console.log(`Seeded employee ${employee.employeeId}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
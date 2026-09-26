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
      division: 'General',
      passwordHash,
      active: true,
      role: 'EMPLOYEE',
    },
    create: {
      employeeId: '1000001',
      name: 'Demo Employee',
      division: 'General',
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
      division: 'Administration',
      passwordHash: hrPasswordHash,
      active: true,
      role: 'HR',
    },
    create: {
      employeeId: '9000001',
      name: 'Demo HR',
      division: 'Administration',
      passwordHash: hrPasswordHash,
      role: 'HR',
    },
  });

  const officeLatitude = process.env.OFFICE_LATITUDE;
  const officeLongitude = process.env.OFFICE_LONGITUDE;
  const officeRadius = Number(process.env.OFFICE_RADIUS_METERS);

  if (!officeLatitude || !officeLongitude || !Number.isFinite(officeRadius) || officeRadius <= 0) {
    throw new Error(
      'OFFICE_LATITUDE, OFFICE_LONGITUDE and OFFICE_RADIUS_METERS are required for the seed.',
    );
  }

  await prisma.office.upsert({
    where: { id: '00000000-0000-0000-0000-000000000001' },
    update: {
      latitude: officeLatitude,
      longitude: officeLongitude,
      radiusMeters: officeRadius,
      maxGpsAccuracyMeters: Number(process.env.MAX_GPS_ACCURACY_METERS ?? 100),
      maxLocationAgeSeconds: Number(process.env.MAX_LOCATION_AGE_SECONDS ?? 120),
    },
    create: {
      id: '00000000-0000-0000-0000-000000000001',
      name: 'Configured Office',
      // ============================================================
      // WORKPLACE GEOFENCE CONFIGURATION
      // ============================================================
      // Set OFFICE_LATITUDE and OFFICE_LONGITUDE to the workplace
      // coordinates for the organization deploying this system.
      // Set OFFICE_RADIUS_METERS to the permitted geofence radius.
      // These values belong in the private deployment environment,
      // not as real organizational coordinates in this public repo.
      // ============================================================
      latitude: officeLatitude,
      longitude: officeLongitude,
      radiusMeters: officeRadius,
      maxGpsAccuracyMeters: Number(process.env.MAX_GPS_ACCURACY_METERS ?? 100),
      maxLocationAgeSeconds: Number(process.env.MAX_LOCATION_AGE_SECONDS ?? 120),
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
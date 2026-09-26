import { ConflictException } from '@nestjs/common';
import { AttendanceService } from './attendance.service';

describe('AttendanceService', () => {
  it('reports no attendance for a new day', async () => {
    const prisma = {
      attendanceSession: { findUnique: jest.fn().mockResolvedValue(null) },
    } as any;

    const service = new AttendanceService(prisma);
    const result = await service.status('employee-id');

    expect(result.state).toBe('NOT_STARTED');
    expect(result.clockedIn).toBe(false);
    expect(result.session).toBeNull();
  });

  it('rejects a second clock-in for the same day', async () => {
    const prisma = {
      employee: {
        findUnique: jest.fn().mockResolvedValue({ id: 'employee-id', active: true }),
      },
      attendanceSession: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'existing-session',
          attendanceDate: new Date(),
          clockInAt: new Date(),
          clockOutAt: null,
        }),
      },
      $transaction: jest.fn(async (callback: any) => callback({
        $queryRaw: jest.fn(),
        attendanceSession: {
          findUnique: jest.fn().mockResolvedValue({ id: 'existing-session', clockInAt: new Date(), clockOutAt: null }),
        },
      })),
      auditEvent: { create: jest.fn() },
    } as any;

    const service = new AttendanceService(prisma);
    (service as any).validateLocation = jest.fn().mockResolvedValue({ officeId: 'office', distanceMeters: 10 });

    await expect(
      service.clockIn('employee-id', {
        latitude: 5.6,
        longitude: -0.18,
        accuracyMeters: 10,
        locationTimestamp: new Date().toISOString(),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

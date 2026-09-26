import { ConflictException } from '@nestjs/common';
import { AttendanceService } from './attendance.service';

describe('AttendanceService', () => {
  it('rejects clock-in when an open session already exists', async () => {
    const prisma = {
      employee: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'employee-id',
          active: true,
        }),
      },
      attendanceSession: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'existing-session',
          clockOutAt: null,
        }),
      },
      auditEvent: {
        create: jest.fn().mockResolvedValue({}),
      },
    } as any;

    const service = new AttendanceService(prisma);

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

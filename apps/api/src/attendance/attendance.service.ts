import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AttendanceEventType, AttendanceResult, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { LocationDto } from './attendance.dto';

interface LocationCheck {
  officeId: string;
  distanceMeters: number;
}

@Injectable()
export class AttendanceService {
  constructor(private readonly prisma: PrismaService) {}

  async status(employeeId: string) {
    const session = await this.prisma.attendanceSession.findFirst({
      where: { employeeId, clockOutAt: null },
      orderBy: { clockInAt: 'desc' },
    });

    return {
      clockedIn: Boolean(session),
      session,
    };
  }

  private errorDetails(error: unknown) {
    if (error instanceof BadRequestException) {
      const response = error.getResponse();
      if (typeof response === 'object' && response !== null) {
        const body = response as Record<string, unknown>;
        return {
          code: typeof body.code === 'string' ? body.code : 'LOCATION_VALIDATION_FAILED',
          reason: typeof body.message === 'string' ? body.message : 'Location validation failed.',
          action: typeof body.action === 'string' ? body.action : undefined,
        };
      }

      if (typeof response === 'string') {
        return {
          code: 'LOCATION_VALIDATION_FAILED',
          reason: response,
        };
      }
    }

    return {
      code: 'LOCATION_VALIDATION_FAILED',
      reason: error instanceof Error ? error.message : 'Location validation failed.',
    };
  }

  private async recordRejectedAttempt(
    employeeId: string,
    eventType: AttendanceEventType,
    dto: LocationDto,
    error: unknown,
    ip?: string,
    userAgent?: string,
    sessionId?: string,
  ) {
    const details = this.errorDetails(error);

    await this.prisma.$transaction([
      this.prisma.attendanceEvidence.create({
        data: {
          employeeId,
          sessionId,
          eventType,
          result: AttendanceResult.REJECTED,
          latitude: dto.latitude,
          longitude: dto.longitude,
          accuracyMeters: dto.accuracyMeters,
          locationTimestamp: new Date(dto.locationTimestamp),
          reason: details.reason,
          ipAddress: ip,
          userAgent,
        },
      }),
      this.prisma.auditEvent.create({
        data: {
          targetEmployeeId: employeeId,
          action: `ATTENDANCE_${eventType}`,
          result: AttendanceResult.REJECTED,
          reason: details.reason,
          metadata: {
            code: details.code,
            action: details.action,
            latitude: dto.latitude,
            longitude: dto.longitude,
            accuracyMeters: dto.accuracyMeters,
            locationTimestamp: dto.locationTimestamp,
            ipAddress: ip,
            userAgent,
          },
        },
      }),
    ]);
  }

  private async validateLocation(dto: LocationDto): Promise<LocationCheck> {
    const globalAccuracyLimit = Number(process.env.MAX_GPS_ACCURACY_METERS ?? 100);
    const globalAgeLimit = Number(process.env.MAX_LOCATION_AGE_SECONDS ?? 120);

    if (
      !Number.isFinite(globalAccuracyLimit) ||
      globalAccuracyLimit <= 0 ||
      !Number.isFinite(globalAgeLimit) ||
      globalAgeLimit <= 0
    ) {
      throw new Error('Invalid GPS validation configuration.');
    }

    if (dto.accuracyMeters > globalAccuracyLimit) {
      throw new BadRequestException({
        code: 'LOCATION_ACCURACY_TOO_LOW',
        message: `Your location accuracy is ${Math.round(dto.accuracyMeters)}m.`,
        action: `Move to an area with a clearer GPS signal and try again. The required accuracy is ${globalAccuracyLimit}m or better.`,
      });
    }

    const locationTime = new Date(dto.locationTimestamp);
    const ageMs = Date.now() - locationTime.getTime();

    if (
      !Number.isFinite(locationTime.getTime()) ||
      ageMs < -30_000 ||
      ageMs > globalAgeLimit * 1000
    ) {
      throw new BadRequestException({
        code: 'LOCATION_STALE',
        message: 'Your location reading is too old or invalid.',
        action: 'Keep location services enabled and try again so the app can obtain a fresh location.',
      });
    }

    const offices = await this.prisma.office.findMany({
      where: { active: true },
    });

    if (!offices.length) {
      throw new BadRequestException('No active attendance location is configured.');
    }

    for (const office of offices) {
      const officeAccuracyLimit = Math.min(
        globalAccuracyLimit,
        office.maxGpsAccuracyMeters,
      );
      const officeAgeLimit = Math.min(
        globalAgeLimit,
        office.maxLocationAgeSeconds,
      );

      if (dto.accuracyMeters > officeAccuracyLimit) {
        continue;
      }

      if (ageMs > officeAgeLimit * 1000) {
        continue;
      }

      if (!Number.isFinite(office.radiusMeters) || office.radiusMeters <= 0) {
        continue;
      }

      const rows = await this.prisma.$queryRaw<{ distance: number }[]>(
        Prisma.sql`
          SELECT ST_Distance(
            ST_SetSRID(ST_MakePoint(${dto.longitude}, ${dto.latitude}), 4326)::geography,
            ST_SetSRID(ST_MakePoint(${office.longitude}, ${office.latitude}), 4326)::geography
          ) AS distance
        `,
      );

      const distance = Number(rows[0]?.distance);
      if (Number.isFinite(distance) && distance <= office.radiusMeters) {
        return { officeId: office.id, distanceMeters: distance };
      }
    }

    throw new BadRequestException({
      code: 'OUTSIDE_GEOFENCE',
      message: 'Your current location is outside the permitted attendance area.',
      action: 'Move inside the configured attendance area and try again.',
    });
  }

  async clockIn(
    employeeId: string,
    dto: LocationDto,
    ip?: string,
    userAgent?: string,
  ) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
    });

    if (!employee || !employee.active) {
      throw new UnauthorizedException();
    }

    const existing = await this.prisma.attendanceSession.findFirst({
      where: { employeeId, clockOutAt: null },
    });

    if (existing) {
      const error = new ConflictException('You are already clocked in.');
      await this.prisma.auditEvent.create({
        data: {
          targetEmployeeId: employeeId,
          action: 'ATTENDANCE_CLOCK_IN',
          result: AttendanceResult.REJECTED,
          reason: error.message,
          metadata: { code: 'ALREADY_CLOCKED_IN' },
        },
      });
      throw error;
    }

    let location: LocationCheck;
    try {
      location = await this.validateLocation(dto);
    } catch (error) {
      await this.recordRejectedAttempt(
        employeeId,
        AttendanceEventType.CLOCK_IN,
        dto,
        error,
        ip,
        userAgent,
      );
      throw error;
    }

    return this.prisma.$transaction(async (tx) => {
      // Serialize attendance state changes for the same employee.
      await tx.$queryRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${employeeId}, 0))`,
      );

      const current = await tx.attendanceSession.findFirst({
        where: { employeeId, clockOutAt: null },
      });

      if (current) {
        throw new ConflictException('You are already clocked in.');
      }

      const session = await tx.attendanceSession.create({
        data: {
          employeeId,
          clockInAt: new Date(),
        },
      });

      await tx.attendanceEvidence.create({
        data: {
          employeeId,
          sessionId: session.id,
          eventType: AttendanceEventType.CLOCK_IN,
          result: AttendanceResult.ACCEPTED,
          latitude: dto.latitude,
          longitude: dto.longitude,
          accuracyMeters: dto.accuracyMeters,
          locationTimestamp: new Date(dto.locationTimestamp),
          distanceMeters: location.distanceMeters,
          ipAddress: ip,
          userAgent,
        },
      });

      await tx.auditEvent.create({
        data: {
          targetEmployeeId: employeeId,
          action: 'ATTENDANCE_CLOCK_IN',
          result: AttendanceResult.ACCEPTED,
          metadata: {
            officeId: location.officeId,
            distanceMeters: location.distanceMeters,
            latitude: dto.latitude,
            longitude: dto.longitude,
            accuracyMeters: dto.accuracyMeters,
            locationTimestamp: dto.locationTimestamp,
            ipAddress: ip,
            userAgent,
          },
        },
      });

      return session;
    });
  }

  async clockOut(
    employeeId: string,
    dto: LocationDto,
    ip?: string,
    userAgent?: string,
  ) {
    let session = await this.prisma.attendanceSession.findFirst({
      where: { employeeId, clockOutAt: null },
      orderBy: { clockInAt: 'desc' },
    });

    if (!session) {
      const error = new ConflictException('You are not currently clocked in.');
      await this.prisma.auditEvent.create({
        data: {
          targetEmployeeId: employeeId,
          action: 'ATTENDANCE_CLOCK_OUT',
          result: AttendanceResult.REJECTED,
          reason: error.message,
          metadata: { code: 'NOT_CLOCKED_IN' },
        },
      });
      throw error;
    }

    let location: LocationCheck;
    try {
      location = await this.validateLocation(dto);
    } catch (error) {
      await this.recordRejectedAttempt(
        employeeId,
        AttendanceEventType.CLOCK_OUT,
        dto,
        error,
        ip,
        userAgent,
        session.id,
      );
      throw error;
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${employeeId}, 0))`,
      );

      session = await tx.attendanceSession.findFirst({
        where: { id: session.id, employeeId, clockOutAt: null },
      });

      if (!session) {
        throw new ConflictException('The attendance session was already closed.');
      }

      const updated = await tx.attendanceSession.updateMany({
        where: {
          id: session.id,
          clockOutAt: null,
        },
        data: {
          clockOutAt: new Date(),
        },
      });

      if (updated.count !== 1) {
        throw new ConflictException('The attendance session was already closed.');
      }

      await tx.attendanceEvidence.create({
        data: {
          employeeId,
          sessionId: session.id,
          eventType: AttendanceEventType.CLOCK_OUT,
          result: AttendanceResult.ACCEPTED,
          latitude: dto.latitude,
          longitude: dto.longitude,
          accuracyMeters: dto.accuracyMeters,
          locationTimestamp: new Date(dto.locationTimestamp),
          distanceMeters: location.distanceMeters,
          ipAddress: ip,
          userAgent,
        },
      });

      await tx.auditEvent.create({
        data: {
          targetEmployeeId: employeeId,
          action: 'ATTENDANCE_CLOCK_OUT',
          result: AttendanceResult.ACCEPTED,
          metadata: {
            officeId: location.officeId,
            distanceMeters: location.distanceMeters,
            latitude: dto.latitude,
            longitude: dto.longitude,
            accuracyMeters: dto.accuracyMeters,
            locationTimestamp: dto.locationTimestamp,
            ipAddress: ip,
            userAgent,
          },
        },
      });

      return tx.attendanceSession.findUniqueOrThrow({
        where: { id: session.id },
      });
    });
  }
}

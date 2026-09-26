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

interface OfficeHours {
  start: string;
  end: string;
  startMinutes: number;
  endMinutes: number;
  timezone: string;
}

@Injectable()
export class AttendanceService {
  constructor(private readonly prisma: PrismaService) {}

  private officeHours(): OfficeHours {
    const start = process.env.OFFICE_START_TIME ?? '08:00';
    const end = process.env.OFFICE_END_TIME ?? '17:00';
    const timezone = process.env.ATTENDANCE_TIMEZONE ?? 'UTC';
    const pattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

    if (!pattern.test(start) || !pattern.test(end)) {
      throw new Error('OFFICE_START_TIME and OFFICE_END_TIME must use HH:mm format.');
    }

    const startMinutes = this.timeToMinutes(start);
    const endMinutes = this.timeToMinutes(end);
    if (endMinutes <= startMinutes) {
      throw new Error('OFFICE_END_TIME must be later than OFFICE_START_TIME.');
    }

    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    } catch {
      throw new Error('ATTENDANCE_TIMEZONE must be a valid IANA timezone.');
    }

    return { start, end, startMinutes, endMinutes, timezone };
  }

  private timeToMinutes(value: string) {
    const [hours, minutes] = value.split(':').map(Number);
    return hours * 60 + minutes;
  }

  private localDateParts(date: Date, timezone: string) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);

    const values = Object.fromEntries(
      parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
    );

    return {
      dateKey: `${values.year}-${values.month}-${values.day}`,
      minutes: Number(values.hour) * 60 + Number(values.minute),
    };
  }

  private dateValue(dateKey: string) {
    return new Date(`${dateKey}T00:00:00.000Z`);
  }

  private async todaySession(employeeId: string) {
    const { timezone } = this.officeHours();
    const { dateKey } = this.localDateParts(new Date(), timezone);

    return this.prisma.attendanceSession.findUnique({
      where: {
        employeeId_attendanceDate: {
          employeeId,
          attendanceDate: this.dateValue(dateKey),
        },
      },
    });
  }

  private attendanceState(session: {
    clockInAt: Date | null;
    clockOutAt: Date | null;
  } | null) {
    if (!session) return 'NOT_STARTED' as const;
    if (!session.clockInAt) return 'CLOCKED_OUT_WITHOUT_CLOCK_IN' as const;
    if (!session.clockOutAt) return 'CLOCKED_IN' as const;
    return 'CLOCKED_OUT' as const;
  }

  private complianceStatus(
    session: { clockInAt: Date | null; clockOutAt: Date | null } | null,
  ) {
    if (!session?.clockInAt || !session.clockOutAt) return 'NOT_MET' as const;

    const hours = this.officeHours();
    const clockIn = this.localDateParts(session.clockInAt, hours.timezone).minutes;
    const clockOut = this.localDateParts(session.clockOutAt, hours.timezone).minutes;

    return clockIn <= hours.startMinutes && clockOut >= hours.endMinutes
      ? 'MET' as const
      : 'NOT_MET' as const;
  }

  async status(employeeId: string) {
    const session = await this.todaySession(employeeId);
    const hours = this.officeHours();

    return {
      state: this.attendanceState(session),
      clockedIn: session?.clockInAt != null && session.clockOutAt == null,
      session,
      officeHours: {
        start: hours.start,
        end: hours.end,
      },
      status: this.complianceStatus(session),
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
        return { code: 'LOCATION_VALIDATION_FAILED', reason: response };
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

    if (!Number.isFinite(globalAccuracyLimit) || globalAccuracyLimit <= 0 || !Number.isFinite(globalAgeLimit) || globalAgeLimit <= 0) {
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

    if (!Number.isFinite(locationTime.getTime()) || ageMs < -30_000 || ageMs > globalAgeLimit * 1000) {
      throw new BadRequestException({
        code: 'LOCATION_STALE',
        message: 'Your location reading is too old or invalid.',
        action: 'Keep location services enabled and try again so the app can obtain a fresh location.',
      });
    }

    const offices = await this.prisma.office.findMany({ where: { active: true } });
    if (!offices.length) {
      throw new BadRequestException({
        code: 'NO_ATTENDANCE_LOCATION',
        message: 'No attendance location is configured.',
        action: 'Contact the system administrator to configure the workplace location.',
      });
    }

    for (const office of offices) {
      const officeAccuracyLimit = Math.min(globalAccuracyLimit, office.maxGpsAccuracyMeters);
      const officeAgeLimit = Math.min(globalAgeLimit, office.maxLocationAgeSeconds);
      if (dto.accuracyMeters > officeAccuracyLimit || ageMs > officeAgeLimit * 1000) continue;
      if (!Number.isFinite(office.radiusMeters) || office.radiusMeters <= 0) continue;

      const rows = await this.prisma.$queryRaw<{ distance: number }[]>(Prisma.sql`
        SELECT ST_Distance(
          ST_SetSRID(ST_MakePoint(${dto.longitude}, ${dto.latitude}), 4326)::geography,
          ST_SetSRID(ST_MakePoint(${office.longitude}, ${office.latitude}), 4326)::geography
        ) AS distance
      `);

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

  private async employeeIsActive(employeeId: string) {
    const employee = await this.prisma.employee.findUnique({ where: { id: employeeId } });
    if (!employee || !employee.active) throw new UnauthorizedException();
    return employee;
  }

  async clockIn(employeeId: string, dto: LocationDto, ip?: string, userAgent?: string) {
    await this.employeeIsActive(employeeId);
    const hours = this.officeHours();
    const { dateKey } = this.localDateParts(new Date(), hours.timezone);
    const attendanceDate = this.dateValue(dateKey);

    let location: LocationCheck;
    try {
      location = await this.validateLocation(dto);
    } catch (error) {
      await this.recordRejectedAttempt(employeeId, AttendanceEventType.CLOCK_IN, dto, error, ip, userAgent);
      throw error;
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${employeeId}, 0))`);

      const current = await tx.attendanceSession.findUnique({
        where: { employeeId_attendanceDate: { employeeId, attendanceDate } },
      });

      if (current?.clockInAt) {
        throw new ConflictException('You have already clocked in today.');
      }

      if (current && !current.clockInAt) {
        throw new ConflictException('Today already has an attendance record without a clock-in.');
      }

      const session = await tx.attendanceSession.create({
        data: { employeeId, attendanceDate, clockInAt: new Date() },
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
          metadata: { officeId: location.officeId, distanceMeters: location.distanceMeters },
        },
      });

      return session;
    });
  }

  async clockOut(employeeId: string, dto: LocationDto, ip?: string, userAgent?: string) {
    await this.employeeIsActive(employeeId);
    const hours = this.officeHours();
    const { dateKey } = this.localDateParts(new Date(), hours.timezone);
    const attendanceDate = this.dateValue(dateKey);

    let location: LocationCheck;
    try {
      location = await this.validateLocation(dto);
    } catch (error) {
      await this.recordRejectedAttempt(employeeId, AttendanceEventType.CLOCK_OUT, dto, error, ip, userAgent);
      throw error;
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${employeeId}, 0))`);

      let session = await tx.attendanceSession.findUnique({
        where: { employeeId_attendanceDate: { employeeId, attendanceDate } },
      });

      const clockOutAt = new Date();

      if (!session) {
        session = await tx.attendanceSession.create({
          data: { employeeId, attendanceDate, clockInAt: null, clockOutAt },
        });
      } else {
        session = await tx.attendanceSession.update({
          where: { id: session.id },
          data: { clockOutAt },
        });
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
            clockInRecorded: Boolean(session.clockInAt),
          },
        },
      });

      return session;
    });
  }
}

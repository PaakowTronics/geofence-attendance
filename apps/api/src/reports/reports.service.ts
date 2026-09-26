import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

interface ReportFilters {
  from: string;
  to: string;
  employeeId?: string;
  division?: string;
}

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private timezone() {
    const timezone = process.env.ATTENDANCE_TIMEZONE ?? 'UTC';
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    } catch {
      throw new BadRequestException('ATTENDANCE_TIMEZONE is not valid.');
    }
    return timezone;
  }

  private parseDate(value: string, name: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new BadRequestException(`${name} must use YYYY-MM-DD format.`);
    }
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`${name} is not a valid date.`);
    }
    return date;
  }

  private workingDays() {
    const configured = (process.env.WORKING_DAYS ?? '1,2,3,4,5')
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value >= 1 && value <= 7);

    return new Set(configured.length ? configured : [1, 2, 3, 4, 5]);
  }

  private dateKey(date: Date, timezone: string) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }

  private weekday(dateKey: string) {
    const date = new Date(`${dateKey}T12:00:00.000Z`);
    return date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  }

  private addDays(date: Date, days: number) {
    const next = new Date(date);
    next.setUTCDate(next.getUTCDate() + days);
    return next;
  }

  private minutesFor(date: Date, timezone: string) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    return hour * 60 + minute;
  }

  private timeToMinutes(value: string) {
    const [hour, minute] = value.split(':').map(Number);
    return hour * 60 + minute;
  }

  private formatTime(date: Date | null, timezone: string) {
    if (!date) return '';
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(date);
  }

  private formatDate(dateKey: string) {
    const [year, month, day] = dateKey.split('-');
    return `${day}/${month}/${year}`;
  }

  private hoursInOffice(clockIn: Date | null, clockOut: Date | null) {
    if (!clockIn || !clockOut) return '';
    const minutes = Math.max(0, Math.round((clockOut.getTime() - clockIn.getTime()) / 60_000));
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }

  private csvEscape(value: string) {
    return `"${value.replace(/"/g, '""')}"`;
  }

  private validateFilters(filters: ReportFilters) {
    const from = this.parseDate(filters.from, 'from');
    const to = this.parseDate(filters.to, 'to');
    if (from > to) throw new BadRequestException('The from date cannot be after the to date.');
    if (filters.employeeId && filters.division) {
      throw new BadRequestException('Choose either an individual employee or a division, not both.');
    }
    return { from, to };
  }

  async attendanceCsv(filters: ReportFilters, role: string) {
    if (role !== 'HR' && role !== 'ADMIN') {
      throw new UnauthorizedException('HR or administrator authorization is required.');
    }

    const { from, to } = this.validateFilters(filters);
    const timezone = this.timezone();
    const workingDays = this.workingDays();
    const officeStart = process.env.OFFICE_START_TIME ?? '08:00';
    const officeEnd = process.env.OFFICE_END_TIME ?? '17:00';
    const officeStartMinutes = this.timeToMinutes(officeStart);
    const officeEndMinutes = this.timeToMinutes(officeEnd);

    const employees = await this.prisma.employee.findMany({
      where: {
        ...(filters.employeeId ? { employeeId: filters.employeeId } : {}),
        ...(filters.division ? { division: filters.division } : {}),
        createdAt: { lte: new Date(`${filters.to}T23:59:59.999Z`) },
      },
      orderBy: [{ division: 'asc' }, { name: 'asc' }],
      select: { id: true, employeeId: true, name: true, division: true },
    });

    const sessions = await this.prisma.attendanceSession.findMany({
      where: {
        attendanceDate: { gte: from, lte: to },
        employeeId: { in: employees.map((employee) => employee.id) },
      },
      select: { employeeId: true, attendanceDate: true, clockInAt: true, clockOutAt: true },
    });

    const byKey = new Map(
      sessions.map((session) => [
        `${session.employeeId}:${session.attendanceDate.toISOString().slice(0, 10)}`,
        session,
      ]),
    );

    const lines = [
      ['Date', 'Staff Name', 'Employee ID', 'Division', 'Clock In', 'Clock Out', 'Hours', 'Status']
        .map((value) => this.csvEscape(value)).join(','),
    ];

    for (const employee of employees) {
      for (let day = new Date(from); day <= to; day = this.addDays(day, 1)) {
        const dateKey = day.toISOString().slice(0, 10);
        if (!workingDays.has(this.weekday(dateKey))) continue;

        const session = byKey.get(`${employee.id}:${dateKey}`);
        const clockIn = session?.clockInAt ?? null;
        const clockOut = session?.clockOutAt ?? null;
        const status = clockIn && clockOut
          ? this.minutesFor(clockIn, timezone) <= officeStartMinutes &&
            this.minutesFor(clockOut, timezone) >= officeEndMinutes
            ? 'Met'
            : 'Not Met'
          : 'Not Met';

        lines.push([
          this.formatDate(dateKey),
          employee.name,
          employee.employeeId,
          employee.division ?? '',
          this.formatTime(clockIn, timezone),
          this.formatTime(clockOut, timezone),
          this.hoursInOffice(clockIn, clockOut),
          status,
        ].map((value) => this.csvEscape(value)).join(','));
      }
    }

    return lines.join('\r\n') + '\r\n';
  }
}

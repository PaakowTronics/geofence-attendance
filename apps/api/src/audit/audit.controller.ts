import {
  Controller,
  Get,
  Headers,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma.service';

@Controller('audit')
export class AuditController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  @Get('attendance')
  async attendance(
    @Headers('authorization') authorization?: string,
    @Query('employeeId') employeeId?: string,
  ) {
    if (!authorization?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authentication required.');
    }

    let payload: { sub: string; role: string };
    try {
      payload = this.jwt.verify(authorization.slice('Bearer '.length), {
        secret: process.env.JWT_ACCESS_SECRET,
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired session.');
    }

    if (payload.role !== 'HR' && payload.role !== 'ADMIN') {
      throw new UnauthorizedException('HR or administrator authorization is required.');
    }

    let targetEmployeeId: string | undefined;

    if (employeeId) {
      const target = await this.prisma.employee.findUnique({
        where: { employeeId },
        select: { id: true },
      });

      if (!target) {
        return [];
      }

      targetEmployeeId = target.id;
    }

    return this.prisma.auditEvent.findMany({
      where: {
        action: { in: ['ATTENDANCE_CLOCK_IN', 'ATTENDANCE_CLOCK_OUT'] },
        ...(targetEmployeeId ? { targetEmployeeId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        action: true,
        result: true,
        reason: true,
        metadata: true,
        createdAt: true,
        targetEmployee: {
          select: {
            employeeId: true,
            name: true,
          },
        },
      },
    });
  }
}

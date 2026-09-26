import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { AttendanceService } from './attendance.service';
import { LocationDto } from './attendance.dto';
import { JwtService } from '@nestjs/jwt';

@Controller('attendance')
export class AttendanceController {
  constructor(
    private readonly attendance: AttendanceService,
    private readonly jwt: JwtService,
  ) {}

  private getEmployeeId(auth?: string) {
    if (!auth?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authentication required.');
    }

    try {
      const payload = this.jwt.verify<{ sub: string }>(
        auth.slice('Bearer '.length),
        { secret: process.env.JWT_ACCESS_SECRET },
      );
      return payload.sub;
    } catch {
      throw new UnauthorizedException('Invalid or expired session.');
    }
  }

  @Get('status')
  status(@Headers('authorization') authorization?: string) {
    return this.attendance.status(this.getEmployeeId(authorization));
  }

  @Post('clock-in')
  clockIn(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: LocationDto,
    @Req() req: Request,
  ) {
    return this.attendance.clockIn(
      this.getEmployeeId(authorization),
      dto,
      req.ip,
      req.headers['user-agent'],
    );
  }

  @Post('clock-out')
  clockOut(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: LocationDto,
    @Req() req: Request,
  ) {
    return this.attendance.clockOut(
      this.getEmployeeId(authorization),
      dto,
      req.ip,
      req.headers['user-agent'],
    );
  }
}

import { Controller, Get, Headers, Query, Res, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Response } from 'express';
import { ReportsService } from './reports.service';

@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly jwt: JwtService,
  ) {}

  @Get('attendance.csv')
  async attendanceCsv(
    @Headers('authorization') authorization: string | undefined,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('employeeId') employeeId: string | undefined,
    @Query('division') division: string | undefined,
    @Res() res: Response,
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

    const csv = await this.reports.attendanceCsv(
      { from, to, employeeId, division },
      payload.role,
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="attendance-report.csv"');
    res.send(csv);
  }
}

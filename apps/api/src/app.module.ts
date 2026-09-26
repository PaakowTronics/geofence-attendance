import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { AttendanceController } from './attendance/attendance.controller';
import { AttendanceService } from './attendance/attendance.service';
import { AuditController } from './audit/audit.controller';
import { PrismaService } from './prisma.service';
import { RedisService } from './redis.service';
import { ReportsController } from './reports/reports.controller';
import { ReportsService } from './reports/reports.service';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_ACCESS_SECRET,
    }),
  ],
  controllers: [AuthController, AttendanceController, AuditController, ReportsController],
  providers: [PrismaService, RedisService, AuthService, AttendanceService, ReportsService],
})
export class AppModule {}

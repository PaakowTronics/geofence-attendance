import {
  Injectable,
  TooManyRequestsException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma.service';
import { RedisService } from '../redis.service';

interface AuthResult {
  accessToken: string;
  refreshToken: string;
  employee: {
    id: string;
    employeeId: string;
    name: string;
    role: string;
  };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly redis: RedisService,
  ) {}

  private hashRefreshToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private async enforceLoginRateLimit(key: string) {
    const attempts = await this.redis.incrementWithExpiry(`login:${key}`, 60);
    if (attempts > 10) {
      throw new TooManyRequestsException(
        'Too many login attempts. Please try again later.',
      );
    }
  }

  private accessTokenLifetimeSeconds() {
    const value = process.env.ACCESS_TOKEN_TTL ?? '15m';
    const match = value.trim().match(/^(\d+)(s|m|h|d)$/i);

    if (!match) {
      throw new Error('ACCESS_TOKEN_TTL must use a format such as 900s, 15m, 1h, or 1d.');
    }

    const amount = Number(match[1]);
    const multiplier = { s: 1, m: 60, h: 3600, d: 86_400 }[match[2].toLowerCase() as 's' | 'm' | 'h' | 'd'];

    return amount * multiplier;
  }

  private async createAccessToken(employee: {
    id: string;
    employeeId: string;
    role: string;
  }) {
    return this.jwt.signAsync(
      {
        sub: employee.id,
        employeeId: employee.employeeId,
        role: employee.role,
      },
      { expiresIn: this.accessTokenLifetimeSeconds() },
    );
  }

  private async issueRefreshToken(employeeId: string) {
    const rawToken = randomBytes(48).toString('base64url');
    const tokenHash = this.hashRefreshToken(rawToken);
    const days = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 7);

    if (!Number.isFinite(days) || days <= 0) {
      throw new Error('REFRESH_TOKEN_TTL_DAYS must be a positive number.');
    }

    const expiresAt = new Date(Date.now() + days * 86_400_000);

    await this.prisma.refreshToken.create({
      data: { employeeId, tokenHash, expiresAt },
    });

    return rawToken;
  }

  async login(employeeId: string, password: string, clientKey: string): Promise<AuthResult> {
    await this.enforceLoginRateLimit(clientKey);

    const employee = await this.prisma.employee.findUnique({
      where: { employeeId },
    });

    if (!employee || !employee.active) {
      throw new UnauthorizedException('Invalid employee ID or password.');
    }

    const valid = await argon2.verify(employee.passwordHash, password);
    if (!valid) {
      throw new UnauthorizedException('Invalid employee ID or password.');
    }

    const accessToken = await this.createAccessToken(employee);
    const refreshToken = await this.issueRefreshToken(employee.id);

    return {
      accessToken,
      refreshToken,
      employee: {
        id: employee.id,
        employeeId: employee.employeeId,
        name: employee.name,
        role: employee.role,
      },
    };
  }

  async refresh(rawToken?: string): Promise<AuthResult> {
    if (!rawToken) {
      throw new UnauthorizedException('Refresh session is required.');
    }

    const tokenHash = this.hashRefreshToken(rawToken);

    return this.prisma.$transaction(async (tx) => {
      const stored = await tx.refreshToken.findUnique({
        where: { tokenHash },
      });

      if (!stored || stored.revokedAt || stored.expiresAt.getTime() <= Date.now()) {
        throw new UnauthorizedException('Invalid or expired refresh token.');
      }

      const revoked = await tx.refreshToken.updateMany({
        where: {
          id: stored.id,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });

      if (revoked.count !== 1) {
        throw new UnauthorizedException('Invalid or expired refresh token.');
      }

      const employee = await tx.employee.findUnique({
        where: { id: stored.employeeId },
      });

      if (!employee || !employee.active) {
        throw new UnauthorizedException('Employee account is inactive.');
      }

      const rawReplacement = randomBytes(48).toString('base64url');
      const replacementHash = this.hashRefreshToken(rawReplacement);
      const days = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 7);
      if (!Number.isFinite(days) || days <= 0) {
        throw new Error('REFRESH_TOKEN_TTL_DAYS must be a positive number.');
      }

      await tx.refreshToken.create({
        data: {
          employeeId: employee.id,
          tokenHash: replacementHash,
          expiresAt: new Date(Date.now() + days * 86_400_000),
        },
      });

      const accessToken = await this.createAccessToken(employee);

      return {
        accessToken,
        refreshToken: rawReplacement,
        employee: {
          id: employee.id,
          employeeId: employee.employeeId,
          name: employee.name,
          role: employee.role,
        },
      };
    });
  }

  async logout(rawToken: string) {
    const tokenHash = this.hashRefreshToken(rawToken);

    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return { success: true };
  }
}

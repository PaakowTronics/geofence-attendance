import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { Request, Response } from 'express';
import { LoginDto } from './auth.dto';
import { AuthService } from './auth.service';

class RefreshDto {
  @IsOptional()
  @IsString()
  @MinLength(20)
  refreshToken?: string;
}

const refreshCookieName = 'timeclock_refresh';

function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
  };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(dto.employeeId, dto.password, req.ip ?? 'unknown');
    res.cookie(refreshCookieName, result.refreshToken, {
      ...refreshCookieOptions(),
      maxAge: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 7) * 86_400_000,
    });

    return {
      accessToken: result.accessToken,
      employee: result.employee,
    };
  }

  @Post('refresh')
  async refresh(
    @Body() dto: RefreshDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rawToken = req.cookies?.[refreshCookieName] ?? dto.refreshToken;
    const result = await this.auth.refresh(rawToken);

    res.cookie(refreshCookieName, result.refreshToken, {
      ...refreshCookieOptions(),
      maxAge: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 7) * 86_400_000,
    });

    return {
      accessToken: result.accessToken,
      employee: result.employee,
    };
  }

  @Post('logout')
  async logout(
    @Body() dto: RefreshDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rawToken = req.cookies?.[refreshCookieName] ?? dto.refreshToken;
    if (rawToken) {
      await this.auth.logout(rawToken);
    }

    res.clearCookie(refreshCookieName, refreshCookieOptions());
    return { success: true };
  }
}

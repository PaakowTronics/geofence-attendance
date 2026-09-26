import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

function validateEnvironment() {
  const required = ['DATABASE_URL', 'REDIS_URL', 'JWT_ACCESS_SECRET', 'CORS_ORIGIN'];
  const missing = required.filter((name) => !process.env[name]);

  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if ((process.env.JWT_ACCESS_SECRET ?? '').length < 32) {
    throw new Error('JWT_ACCESS_SECRET must be at least 32 characters long.');
  }

  const refreshDays = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 7);
  if (!Number.isFinite(refreshDays) || refreshDays <= 0) {
    throw new Error('REFRESH_TOKEN_TTL_DAYS must be a positive number.');
  }
}

async function bootstrap() {
  validateEnvironment();

  const app = await NestFactory.create(AppModule);

  app.set('trust proxy', 1);
  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableCors({
    origin: process.env.CORS_ORIGIN,
    credentials: true,
  });

  await app.listen(Number(process.env.API_PORT ?? 3000));
}

bootstrap();

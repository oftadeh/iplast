import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

// JSON cannot carry BigInt; prices travel as strings.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function (this: bigint) { return this.toString(); };

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableCors({ origin: (process.env.CORS_ORIGINS ?? '').split(',').filter(Boolean) });
  await app.listen(Number(process.env.API_PORT ?? 3000));
}
bootstrap();

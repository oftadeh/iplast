import { Module } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import { HealthController } from './health/health.controller';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { CatalogController } from './catalog/catalog.controller';

@Module({
  controllers: [HealthController, AuthController, CatalogController],
  providers: [PrismaService, AuthService],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import { HealthController } from './health/health.controller';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { CatalogController } from './catalog/catalog.controller';
import { TelegramService } from './common/telegram.service';
import { SessionGuard } from './common/session';
import { MeController } from './me/me.controller';
import { OrdersController } from './orders/orders.controller';
import { OrdersService } from './orders/orders.service';
import { AdminOrdersController } from './admin/admin-orders.controller';
import { AdminCustomersController } from './admin/admin-customers.controller';
import { AdminStaffController } from './admin/admin-staff.controller';
import { PricesController } from './prices/prices.controller';
import { AdminConversationsController } from './admin/admin-conversations.controller';
import { AccountingService, AdminAccountsController, MyAccountController } from './accounting/accounting';
import { PriceAiService } from './prices/price-ai.service';
import { AdminProductsController, MediaController } from './admin/admin-products.controller';
import { AdminBroadcastController } from './admin/admin-broadcast.controller';
import { AdminProxyController } from './admin/admin-proxy.controller';
import { AssistantController, InternalAssistantController, InternalOrdersController, InternalPaymentsController } from './assistant/assistant.controller';
import { AssistantService } from './assistant/assistant.service';

@Module({
  controllers: [HealthController, AuthController, CatalogController, MeController, OrdersController, AdminOrdersController, AdminCustomersController, AdminStaffController, PricesController, AdminConversationsController, AssistantController, InternalAssistantController, InternalOrdersController, InternalPaymentsController, AdminProductsController, MediaController, AdminAccountsController, MyAccountController, AdminBroadcastController, AdminProxyController],
  providers: [PrismaService, AuthService, TelegramService, SessionGuard, OrdersService, AssistantService, PriceAiService, AccountingService],
})
export class AppModule {}

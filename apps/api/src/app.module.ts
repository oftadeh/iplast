import { AdminGrowthController, InternalReferralController, ShareController, WeeklyReport } from './growth/growth';
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
import { AdminCustomersController, AdminJoinsController } from './admin/admin-customers.controller';
import { AdminStaffController } from './admin/admin-staff.controller';
import { PricesController } from './prices/prices.controller';
import { AdminConversationsController } from './admin/admin-conversations.controller';
import { AdminDocumentsController, DocumentsService, MyDocumentsController } from './documents/documents';
import { AccountingService, AdminAccountsController, MyAccountController } from './accounting/accounting';
import { PriceAiService } from './prices/price-ai.service';
import { AdminProductsController, MediaController } from './admin/admin-products.controller';
import { AdminBroadcastController } from './admin/admin-broadcast.controller';
import { AdminProxyController } from './admin/admin-proxy.controller';
import { AdminDashboardController } from './admin/admin-dashboard.controller';
import { MeChatController } from './me/me-chat.controller';
import { AssistantController, InternalAgentController, InternalAssistantController, InternalOrdersController, InternalPaymentsController } from './assistant/assistant.controller';
import { AssistantService } from './assistant/assistant.service';
import { SalesAgentService } from './assistant/sales-agent.service';

@Module({
  controllers: [HealthController, AuthController, CatalogController, MeController, OrdersController, AdminOrdersController, AdminCustomersController, AdminJoinsController, AdminStaffController, PricesController, AdminConversationsController, AssistantController, InternalAssistantController, InternalOrdersController, InternalPaymentsController, AdminProductsController, MediaController, AdminAccountsController, MyAccountController, AdminBroadcastController, AdminProxyController, AdminDashboardController, MeChatController, InternalAgentController, AdminDocumentsController, MyDocumentsController, AdminGrowthController, InternalReferralController, ShareController],
  providers: [PrismaService, AuthService, TelegramService, SessionGuard, OrdersService, AssistantService, PriceAiService, AccountingService, SalesAgentService, DocumentsService, WeeklyReport],
})
export class AppModule {}

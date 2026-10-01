import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AuditModule } from "./audit/audit.service";
import { AutomationsModule } from "./automations/automations.service";
import { BankModule } from "./bank/bank.service";
import { FinanceModule } from "./finance/finance.module";
import { FiscalModule } from "./fiscal/fiscal.service";
import { MarketplacesModule } from "./marketplaces/marketplaces.service";
import { PixModule } from "./pix/pix.service";
import { PlatformModule } from "./platform/platform.service";
import { SubscriptionModule } from "./subscription/subscription.service";
import { InsightsModule } from "./insights/insights.service";
import { IntegrationsModule } from "./integrations/integrations.service";
import { InventoryModule } from "./inventory/inventory.service";
import { NotificationsModule } from "./notifications/notifications.service";
import { AuthModule } from "./auth/auth.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { PermissionsGuard } from "./common/guards/permissions.guard";
import { SessionGuard } from "./common/guards/session.guard";
import { SubscriptionGuard } from "./common/guards/subscription.guard";
import { CompanyModule } from "./company/company.module";
import { RedisThrottlerStorage } from "./common/redis-throttler.storage";
import { AppConfigModule } from "./config/config.module";
import { ENV, type Env } from "./config/env";
import { CustomersModule } from "./customers/customers.module";
import { HealthController } from "./health.controller";
import { MailModule } from "./mail/mail.service";
import { PosModule } from "./pos/pos.module";
import { PrismaModule } from "./prisma/prisma.service";
import { ProductsModule } from "./products/products.module";
import { SalesModule } from "./sales/sales.module";
import { UploadsModule } from "./uploads/uploads.module";
import { UsersModule } from "./users/users.module";

@Module({
  imports: [
    AppConfigModule, PrismaModule, AuditModule, MailModule, IntegrationsModule, NotificationsModule, AutomationsModule,
    ThrottlerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        throttlers: [{ ttl: 60_000, limit: 300 }],
        skipIf: () => process.env.DISABLE_THROTTLE === "1",
        storage: env.redisUrl ? new RedisThrottlerStorage(env.redisUrl) : undefined,
      }),
    }),
    AuthModule, CompanyModule, UsersModule, ProductsModule, CustomersModule, SalesModule, PosModule, UploadsModule,
    FinanceModule, InventoryModule, InsightsModule, SubscriptionModule, FiscalModule, PixModule, BankModule, MarketplacesModule, PlatformModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: SubscriptionGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}

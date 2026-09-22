import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import type { AuthContext } from "../common/auth-context";
import { Auth, ClientIp, RequirePermission } from "../common/decorators";
import { ListQuery } from "../common/pagination";
import { EntryDto, FinanceService } from "./finance.service";

@Controller("finance")
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}

  @RequirePermission("finance:view") @Get("overview") overview(@Auth() ctx: AuthContext) { return this.finance.overview(ctx); }
  @RequirePermission("finance:view") @Get("accounts") accounts(@Auth() ctx: AuthContext) { return this.finance.accounts(ctx); }
  @RequirePermission("finance:view") @Get("categories") categories(@Auth() ctx: AuthContext) { return this.finance.categories(ctx); }
  @RequirePermission("finance:view") @Get("transactions") transactions(@Auth() ctx: AuthContext, @Query() q: ListQuery) { return this.finance.transactions(ctx, q); }

  @RequirePermission("finance:view") @Get("payables") payables(@Auth() ctx: AuthContext, @Query() q: ListQuery) { return this.finance.listEntries(ctx, "pagar", q); }
  @RequirePermission("finance:create") @Post("payables") createPayable(@Auth() ctx: AuthContext, @Body() dto: EntryDto, @ClientIp() ip: string) { return this.finance.createEntry(ctx, "pagar", dto, ip); }
  @RequirePermission("finance:edit") @Post("payables/:id/settle") settlePayable(@Auth() ctx: AuthContext, @Param("id") id: string, @ClientIp() ip: string) { return this.finance.settle(ctx, "pagar", id, ip); }

  @RequirePermission("finance:view") @Get("receivables") receivables(@Auth() ctx: AuthContext, @Query() q: ListQuery) { return this.finance.listEntries(ctx, "receber", q); }
  @RequirePermission("finance:create") @Post("receivables") createReceivable(@Auth() ctx: AuthContext, @Body() dto: EntryDto, @ClientIp() ip: string) { return this.finance.createEntry(ctx, "receber", dto, ip); }
  @RequirePermission("finance:edit") @Post("receivables/:id/settle") settleReceivable(@Auth() ctx: AuthContext, @Param("id") id: string, @ClientIp() ip: string) { return this.finance.settle(ctx, "receber", id, ip); }
}

@Controller("wallet")
export class WalletController {
  constructor(private readonly finance: FinanceService) {}
  @RequirePermission("wallet:view") @Get("summary") summary(@Auth() ctx: AuthContext) { return this.finance.walletSummary(ctx); }
  @RequirePermission("wallet:view") @Get("statement") statement(@Auth() ctx: AuthContext, @Query() q: ListQuery) { return this.finance.walletStatement(ctx, q); }
}

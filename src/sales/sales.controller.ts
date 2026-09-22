import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import type { AuthContext } from "../common/auth-context";
import { Auth, ClientIp, RequirePermission } from "../common/decorators";
import { ListQuery } from "../common/pagination";
import { CreateSaleDto, SalesService } from "./sales.service";

@Controller("sales")
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @RequirePermission("sales:view") @Get()
  list(@Auth() ctx: AuthContext, @Query() q: ListQuery) { return this.sales.list(ctx, q); }

  @RequirePermission("sales:view") @Get("summary")
  summary(@Auth() ctx: AuthContext) { return this.sales.summary(ctx); }

  @RequirePermission("sales:view") @Get(":id")
  get(@Auth() ctx: AuthContext, @Param("id") id: string) { return this.sales.get(ctx, id); }

  @RequirePermission("sales:create") @Post()
  create(@Auth() ctx: AuthContext, @Body() dto: CreateSaleDto, @ClientIp() ip: string) { return this.sales.create(ctx, dto, ip); }

  @RequirePermission("sales:edit") @Post(":id/complete")
  complete(@Auth() ctx: AuthContext, @Param("id") id: string, @ClientIp() ip: string) { return this.sales.complete(ctx, id, ip); }

  @RequirePermission("sales:delete") @Post(":id/cancel")
  cancel(@Auth() ctx: AuthContext, @Param("id") id: string, @ClientIp() ip: string) { return this.sales.cancel(ctx, id, ip); }
}

import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import type { AuthContext } from "../common/auth-context";
import { Auth, ClientIp, RequirePermission } from "../common/decorators";
import { ListQuery } from "../common/pagination";
import { CustomerDto, CustomersService } from "./customers.service";

@Controller("customers")
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @RequirePermission("customers:view") @Get()
  list(@Auth() ctx: AuthContext, @Query() q: ListQuery) { return this.customers.list(ctx, q); }

  @RequirePermission("customers:view") @Get("search")
  search(@Auth() ctx: AuthContext, @Query("q") q?: string) { return this.customers.search(ctx, q); }

  @RequirePermission("customers:view") @Get(":id")
  get(@Auth() ctx: AuthContext, @Param("id") id: string) { return this.customers.get(ctx, id); }

  @RequirePermission("customers:view") @Get(":id/purchases")
  purchases(@Auth() ctx: AuthContext, @Param("id") id: string) { return this.customers.purchases(ctx, id); }

  @RequirePermission("customers:create") @Post()
  create(@Auth() ctx: AuthContext, @Body() dto: CustomerDto, @ClientIp() ip: string) { return this.customers.create(ctx, dto, ip); }
}

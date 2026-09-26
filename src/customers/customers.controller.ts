import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { Type } from "class-transformer";
import { IsNumber, Max, Min } from "class-validator";
import type { AuthContext } from "../common/auth-context";
import { Auth, ClientIp, RequirePermission } from "../common/decorators";
import { ListQuery } from "../common/pagination";
import { CustomerDto, CustomersService } from "./customers.service";

export class CreditLimitDto {
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }, { message: "Informe o limite da carteira." }) @Min(0, { message: "O limite não pode ser negativo." }) @Max(99_999_999.99) creditLimit: number;
}

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

  @RequirePermission("customers:credit") @Patch(":id/credit-limit")
  setCreditLimit(@Auth() ctx: AuthContext, @Param("id") id: string, @Body() dto: CreditLimitDto, @ClientIp() ip: string) {
    return this.customers.setCreditLimit(ctx, id, dto.creditLimit, ip);
  }
}

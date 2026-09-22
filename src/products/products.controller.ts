import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from "@nestjs/common";
import type { AuthContext } from "../common/auth-context";
import { Auth, ClientIp, RequirePermission } from "../common/decorators";
import { ListQuery } from "../common/pagination";
import { ProductDto, ProductsService, UpdateProductDto } from "./products.service";

@Controller("products")
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @RequirePermission("products:view") @Get()
  list(@Auth() ctx: AuthContext, @Query() q: ListQuery) { return this.products.list(ctx, q); }

  @RequirePermission("products:view") @Get("search")
  search(@Auth() ctx: AuthContext, @Query("q") q?: string) { return this.products.search(ctx, q); }

  @RequirePermission("products:view") @Get(":id")
  get(@Auth() ctx: AuthContext, @Param("id") id: string) { return this.products.get(ctx, id); }

  @RequirePermission("products:create") @Post()
  create(@Auth() ctx: AuthContext, @Body() dto: ProductDto, @ClientIp() ip: string) { return this.products.create(ctx, dto, ip); }

  @RequirePermission("products:edit") @Put(":id")
  update(@Auth() ctx: AuthContext, @Param("id") id: string, @Body() dto: UpdateProductDto, @ClientIp() ip: string) { return this.products.update(ctx, id, dto, ip); }

  @RequirePermission("products:delete") @HttpCode(204) @Delete(":id")
  remove(@Auth() ctx: AuthContext, @Param("id") id: string, @ClientIp() ip: string) { return this.products.remove(ctx, id, ip); }
}

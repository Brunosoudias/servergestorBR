import { Body, Controller, Get, Post, Put } from "@nestjs/common";
import type { AuthContext } from "../common/auth-context";
import { Auth, ClientIp, NoOrg, RequirePermission } from "../common/decorators";
import { CompanyDto } from "./company.dto";
import { CompanyService } from "./company.service";

@Controller("company")
export class CompanyController {
  constructor(private readonly company: CompanyService) {}

  @RequirePermission("settings:view") @Get()
  get(@Auth() ctx: AuthContext) { return this.company.get(ctx); }

  @NoOrg() @Post()
  create(@Auth() ctx: AuthContext, @Body() dto: CompanyDto, @ClientIp() ip: string) { return this.company.create(ctx, dto, ip); }

  @RequirePermission("settings:edit") @Put()
  update(@Auth() ctx: AuthContext, @Body() dto: CompanyDto, @ClientIp() ip: string) { return this.company.update(ctx, dto, ip); }

  @RequirePermission("settings:view") @Get("audit")
  audit(@Auth() ctx: AuthContext) { return this.company.auditTrail(ctx); }
}

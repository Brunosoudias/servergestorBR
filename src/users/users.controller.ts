import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import type { AuthContext } from "../common/auth-context";
import { Auth, ClientIp, RequirePermission } from "../common/decorators";
import { ListQuery } from "../common/pagination";
import { CreateUserDto, InviteDto, UpdateMemberDto, UsersService } from "./users.service";

@Controller("users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @RequirePermission("settings:view") @Get()
  list(@Auth() ctx: AuthContext, @Query() q: ListQuery) { return this.users.list(ctx, q); }

  @RequirePermission("settings:create") @Post()
  create(@Auth() ctx: AuthContext, @Body() dto: CreateUserDto, @ClientIp() ip: string) { return this.users.create(ctx, dto, ip); }

  @RequirePermission("settings:create") @Post("invite")
  invite(@Auth() ctx: AuthContext, @Body() dto: InviteDto, @ClientIp() ip: string) { return this.users.invite(ctx, dto, ip); }

  @RequirePermission("settings:edit") @Patch(":id")
  update(@Auth() ctx: AuthContext, @Param("id") id: string, @Body() dto: UpdateMemberDto, @ClientIp() ip: string) { return this.users.update(ctx, id, dto, ip); }
}

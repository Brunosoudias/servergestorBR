import { Body, Controller, Get, HttpCode, Post, Query } from "@nestjs/common";
import type { AuthContext } from "../common/auth-context";
import { Auth, ClientIp, RequirePermission } from "../common/decorators";
import { ListQuery } from "../common/pagination";
import { CashMoveDto, CloseRegisterDto, OpenRegisterDto, PosSaleDto, PosService } from "./pos.service";

@Controller("pos")
export class PosController {
  constructor(private readonly pos: PosService) {}

  @RequirePermission("pos:view") @Get("register")
  state(@Auth() ctx: AuthContext) { return this.pos.state(ctx); }

  @RequirePermission("pos:open_register") @HttpCode(201) @Post("register/open")
  open(@Auth() ctx: AuthContext, @Body() dto: OpenRegisterDto, @ClientIp() ip: string) { return this.pos.open(ctx, dto, ip); }

  @RequirePermission("pos:close_register") @HttpCode(200) @Post("register/close")
  close(@Auth() ctx: AuthContext, @Body() dto: CloseRegisterDto, @ClientIp() ip: string) { return this.pos.close(ctx, dto, ip); }

  @RequirePermission("pos:withdrawal") @HttpCode(201) @Post("register/withdrawal")
  withdrawal(@Auth() ctx: AuthContext, @Body() dto: CashMoveDto, @ClientIp() ip: string) { return this.pos.move(ctx, "sangria", dto, ip); }

  @RequirePermission("pos:deposit") @HttpCode(201) @Post("register/deposit")
  deposit(@Auth() ctx: AuthContext, @Body() dto: CashMoveDto, @ClientIp() ip: string) { return this.pos.move(ctx, "suprimento", dto, ip); }

  @RequirePermission("pos:sell") @HttpCode(201) @Post("sales")
  sell(@Auth() ctx: AuthContext, @Body() dto: PosSaleDto, @ClientIp() ip: string) { return this.pos.sell(ctx, dto, ip); }

  @RequirePermission("pos:history") @Get("sales")
  history(@Auth() ctx: AuthContext, @Query() q: ListQuery) { return this.pos.history(ctx, q); }
}

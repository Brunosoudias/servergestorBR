import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { AuthContext } from "../common/auth-context";
import { Auth, ClientIp, RequirePermission } from "../common/decorators";
import { ListQuery } from "../common/pagination";
import { AuthorizeDto, PaymentConfigDto, PosConfigService, PosSettingsDto, TerminalDto, UpdateTerminalDto } from "./pos-config.service";
import { CancelPosSaleDto, CashMoveDto, CloseRegisterDto, ForceCloseDto, OpenRegisterDto, PosEventDto, PosSaleDto, PosService, ReceiptEmailDto, SessionsQuery } from "./pos.service";
import { ReturnsService, SaleReturnDto } from "./returns.service";

@Controller("pos")
export class PosController {
  constructor(private readonly pos: PosService, private readonly config: PosConfigService, private readonly returns: ReturnsService) {}

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

  @RequirePermission("pos:cancel") @HttpCode(200) @Post("sales/:id/cancel")
  cancelSale(@Auth() ctx: AuthContext, @Param("id") id: string, @Body() dto: CancelPosSaleDto, @ClientIp() ip: string) { return this.pos.cancelSale(ctx, id, dto, ip); }

  @RequirePermission("pos:history") @Get("sales/:id/returns")
  listReturns(@Auth() ctx: AuthContext, @Param("id") id: string) { return this.returns.list(ctx, id); }

  @RequirePermission("pos:return") @HttpCode(201) @Post("sales/:id/returns")
  createReturn(@Auth() ctx: AuthContext, @Param("id") id: string, @Body() dto: SaleReturnDto, @ClientIp() ip: string) { return this.returns.create(ctx, id, dto, ip); }

  @RequirePermission("pos:view") @Get("customers/:id/credit")
  customerCredit(@Auth() ctx: AuthContext, @Param("id") id: string) { return this.returns.customerCredit(ctx, id); }

  @RequirePermission("pos:history") @Throttle({ default: { limit: 5, ttl: 60_000 } }) @HttpCode(200) @Post("sales/:id/receipt")
  sendReceipt(@Auth() ctx: AuthContext, @Param("id") id: string, @Body() dto: ReceiptEmailDto) { return this.pos.sendReceipt(ctx, id, dto); }

  @RequirePermission("pos:history") @Get("reports/period")
  period(@Auth() ctx: AuthContext, @Query() q: SessionsQuery) { return this.pos.period(ctx, q); }

  @RequirePermission("pos:history") @Get("sessions")
  sessions(@Auth() ctx: AuthContext, @Query() q: SessionsQuery) { return this.pos.sessions(ctx, q); }

  @RequirePermission("pos:history") @Get("sessions/:id")
  report(@Auth() ctx: AuthContext, @Param("id") id: string) { return this.pos.report(ctx, id); }

  @RequirePermission("pos:manage") @HttpCode(200) @Post("sessions/:id/close")
  forceClose(@Auth() ctx: AuthContext, @Param("id") id: string, @Body() dto: ForceCloseDto, @ClientIp() ip: string) { return this.pos.forceClose(ctx, id, dto, ip); }

  @RequirePermission("pos:view") @Throttle({ default: { limit: 10, ttl: 60_000 } }) @HttpCode(201) @Post("authorize")
  authorize(@Auth() ctx: AuthContext, @Body() dto: AuthorizeDto, @ClientIp() ip: string) { return this.config.authorize(ctx, dto, ip); }

  @RequirePermission("pos:view") @HttpCode(201) @Post("events")
  event(@Auth() ctx: AuthContext, @Body() dto: PosEventDto, @ClientIp() ip: string) { return this.pos.event(ctx, dto, ip); }

  @RequirePermission("pos:view") @Get("settings")
  settings(@Auth() ctx: AuthContext) { return this.config.publicSettings(ctx); }

  @RequirePermission("pos:settings") @Put("settings")
  updateSettings(@Auth() ctx: AuthContext, @Body() dto: PosSettingsDto, @ClientIp() ip: string) { return this.config.updateSettings(ctx, dto, ip); }

  @RequirePermission("pos:view") @Get("terminals")
  terminals(@Auth() ctx: AuthContext) { return this.config.terminals(ctx); }

  @RequirePermission("pos:settings") @HttpCode(201) @Post("terminals")
  createTerminal(@Auth() ctx: AuthContext, @Body() dto: TerminalDto, @ClientIp() ip: string) { return this.config.createTerminal(ctx, dto, ip); }

  @RequirePermission("pos:settings") @Put("terminals/:id")
  updateTerminal(@Auth() ctx: AuthContext, @Param("id") id: string, @Body() dto: UpdateTerminalDto, @ClientIp() ip: string) { return this.config.updateTerminal(ctx, id, dto, ip); }

  @RequirePermission("pos:view") @Get("payment-methods")
  paymentMethods(@Auth() ctx: AuthContext) { return this.config.paymentMethods(ctx); }

  @RequirePermission("pos:settings") @Put("payment-methods/:method")
  updatePaymentMethod(@Auth() ctx: AuthContext, @Param("method") method: string, @Body() dto: PaymentConfigDto, @ClientIp() ip: string) { return this.config.updatePaymentMethod(ctx, method, dto, ip); }
}

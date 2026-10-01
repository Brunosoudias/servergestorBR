import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import type { AuthContext, AuthedRequest } from "../common/auth-context";
import { AllowExpired, AllowPendingPassword, Auth, ClientIp, NoOrg, Public } from "../common/decorators";
import { ENV, type Env } from "../config/env";
import { ChangePasswordDto, ForgotPasswordDto, LoginDto, MfaCodeDto, MfaDisableDto, MfaEnableDto, MfaVerifyDto, RegisterDto, ResetPasswordDto } from "./auth.dto";
import { AuthService, type LoginResult } from "./auth.service";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService, @Inject(ENV) private readonly env: Env) {}

  private setCookie(res: Response, token: string, expiresAt: Date) {
    res.cookie(this.env.cookie.name, token, { httpOnly: true, secure: this.env.cookie.secure, sameSite: "lax", path: "/", domain: this.env.cookie.domain, expires: expiresAt });
  }
  private clearCookie(res: Response) {
    res.clearCookie(this.env.cookie.name, { httpOnly: true, secure: this.env.cookie.secure, sameSite: "lax", path: "/", domain: this.env.cookie.domain });
  }
  private respond(res: Response, r: LoginResult) {
    if ("mfaChallenge" in r) return { mfaRequired: true, challenge: r.mfaChallenge };
    this.setCookie(res, r.token, r.expiresAt);
    return r.session;
  }

  @Public() @Throttle({ default: { limit: 5, ttl: 60_000 } }) @Post("register")
  async register(@Body() dto: RegisterDto, @Req() req: AuthedRequest, @ClientIp() ip: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.register(dto, req.header("user-agent") ?? "", ip);
    this.setCookie(res, r.token, r.expiresAt);
    return r.session;
  }

  @Public() @Throttle({ default: { limit: 10, ttl: 60_000 } }) @HttpCode(200) @Post("login")
  async login(@Body() dto: LoginDto, @Req() req: AuthedRequest, @ClientIp() ip: string, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.login(dto, req.header("user-agent") ?? "", ip));
  }

  @Public() @Throttle({ default: { limit: 10, ttl: 60_000 } }) @HttpCode(200) @Post("mfa/verify")
  async verifyMfa(@Body() dto: MfaVerifyDto, @Req() req: AuthedRequest, @ClientIp() ip: string, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.verifyMfaLogin(dto.challenge, dto.code, req.header("user-agent") ?? "", ip));
  }

  @Public() @HttpCode(204) @Post("logout")
  async logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[this.env.cookie.name] as string | undefined;
    if (token) await this.auth.logoutByToken(token);
    this.clearCookie(res);
  }

  @AllowPendingPassword() @Get("me")
  me(@Auth() ctx: AuthContext) {
    return this.auth.buildSession(ctx.user, ctx.organizationId);
  }

  @Public() @Get("options")
  options() { return this.auth.options(); }

  @NoOrg() @AllowExpired() @AllowPendingPassword() @Throttle({ default: { limit: 5, ttl: 60_000 } }) @HttpCode(200) @Post("change-password")
  async changePassword(@Auth() ctx: AuthContext, @Body() dto: ChangePasswordDto, @ClientIp() ip: string) {
    const user = await this.auth.changePassword(ctx.user, dto, ctx.sessionId, ip);
    return this.auth.buildSession(user, ctx.organizationId);
  }

  @NoOrg() @Get("mfa")
  mfaStatus(@Auth() ctx: AuthContext) { return this.auth.mfaStatus(ctx.user); }

  @NoOrg() @AllowExpired() @Throttle({ default: { limit: 10, ttl: 60_000 } }) @HttpCode(200) @Post("mfa/setup")
  mfaSetup(@Auth() ctx: AuthContext) { return this.auth.mfaSetup(ctx.user); }

  @NoOrg() @AllowExpired() @Throttle({ default: { limit: 10, ttl: 60_000 } }) @HttpCode(200) @Post("mfa/enable")
  mfaEnable(@Auth() ctx: AuthContext, @Body() dto: MfaEnableDto, @ClientIp() ip: string) { return this.auth.mfaEnable(ctx.user, dto.code, dto.password, ctx.sessionId, ip); }

  @NoOrg() @AllowExpired() @Throttle({ default: { limit: 5, ttl: 60_000 } }) @HttpCode(200) @Post("mfa/disable")
  mfaDisable(@Auth() ctx: AuthContext, @Body() dto: MfaDisableDto, @ClientIp() ip: string) { return this.auth.mfaDisable(ctx.user, dto.password, dto.code, ip); }

  @NoOrg() @AllowExpired() @Throttle({ default: { limit: 5, ttl: 60_000 } }) @HttpCode(200) @Post("mfa/recovery-codes")
  mfaRecoveryCodes(@Auth() ctx: AuthContext, @Body() dto: MfaCodeDto, @ClientIp() ip: string) { return this.auth.mfaRegenerateRecoveryCodes(ctx.user, dto.code, ip); }

  @Public() @Throttle({ default: { limit: 5, ttl: 60_000 } }) @HttpCode(200) @Post("forgot-password")
  forgot(@Body() dto: ForgotPasswordDto) { return this.auth.forgotPassword(dto.email); }

  @Public() @Throttle({ default: { limit: 10, ttl: 60_000 } }) @HttpCode(200) @Post("reset-password")
  reset(@Body() dto: ResetPasswordDto) { return this.auth.resetPassword(dto.token, dto.password); }
}

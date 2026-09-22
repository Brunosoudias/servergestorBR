import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import type { AuthContext, AuthedRequest } from "../common/auth-context";
import { Auth, ClientIp, Public } from "../common/decorators";
import { ENV, type Env } from "../config/env";
import { ForgotPasswordDto, LoginDto, RegisterDto, ResetPasswordDto } from "./auth.dto";
import { AuthService } from "./auth.service";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService, @Inject(ENV) private readonly env: Env) {}

  private setCookie(res: Response, token: string, expiresAt: Date) {
    res.cookie(this.env.cookie.name, token, { httpOnly: true, secure: this.env.cookie.secure, sameSite: "lax", path: "/", domain: this.env.cookie.domain, expires: expiresAt });
  }
  private clearCookie(res: Response) {
    res.clearCookie(this.env.cookie.name, { httpOnly: true, secure: this.env.cookie.secure, sameSite: "lax", path: "/", domain: this.env.cookie.domain });
  }

  @Public() @Throttle({ default: { limit: 5, ttl: 60_000 } }) @Post("register")
  async register(@Body() dto: RegisterDto, @Req() req: AuthedRequest, @ClientIp() ip: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.register(dto, req.header("user-agent") ?? "", ip);
    this.setCookie(res, r.token, r.expiresAt);
    return r.session;
  }

  @Public() @Throttle({ default: { limit: 10, ttl: 60_000 } }) @HttpCode(200) @Post("login")
  async login(@Body() dto: LoginDto, @Req() req: AuthedRequest, @ClientIp() ip: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.login(dto, req.header("user-agent") ?? "", ip);
    this.setCookie(res, r.token, r.expiresAt);
    return r.session;
  }

  @Public() @HttpCode(204) @Post("logout")
  async logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[this.env.cookie.name] as string | undefined;
    if (token) await this.auth.logoutByToken(token);
    this.clearCookie(res);
  }

  @Get("me")
  me(@Auth() ctx: AuthContext) {
    return this.auth.buildSession(ctx.user, ctx.organizationId);
  }

  @Public() @Throttle({ default: { limit: 5, ttl: 60_000 } }) @HttpCode(200) @Post("forgot-password")
  forgot(@Body() dto: ForgotPasswordDto) { return this.auth.forgotPassword(dto.email); }

  @Public() @Throttle({ default: { limit: 10, ttl: 60_000 } }) @HttpCode(200) @Post("reset-password")
  reset(@Body() dto: ResetPasswordDto) { return this.auth.resetPassword(dto.token, dto.password); }
}

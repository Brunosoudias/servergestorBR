import { Global, Inject, Injectable, Logger, Module } from "@nestjs/common";
import { createTransport, type Transporter } from "nodemailer";
import { ENV, type Env } from "../config/env";

@Injectable()
export class MailService {
  private readonly log = new Logger("Mail");
  private readonly transport: Transporter | null;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.transport = env.smtp ? createTransport({ host: env.smtp.host, port: env.smtp.port, secure: env.smtp.port === 465, auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass } : undefined }) : null;
  }

  async send(to: string, subject: string, text: string) {
    if (!this.transport) { this.log.warn(`[e-mail não enviado — SMTP não configurado]\nPara: ${to}\nAssunto: ${subject}\n${text}`); return; }
    try { await this.transport.sendMail({ from: this.env.mailFrom, to, subject, text }); }
    catch (e) { this.log.error(`Falha ao enviar e-mail para ${to}: ${(e as Error).message}`); }
  }

  passwordReset(to: string, name: string, token: string) {
    return this.send(to, "Gestor Br — redefinição de senha", `Olá, ${name}.\n\nPara criar uma nova senha no Gestor Br, acesse (válido por 1 hora):\n${this.env.webUrl}/reset-password?token=${token}\n\nSe não foi você, ignore este e-mail.`);
  }

  invite(to: string, company: string, inviter: string, token: string) {
    return this.send(to, `Gestor Br — convite para ${company}`, `${inviter} convidou você para acessar ${company} no Gestor Br.\n\nDefina sua senha para entrar (válido por 7 dias):\n${this.env.webUrl}/reset-password?token=${token}`);
  }
}

@Global()
@Module({ providers: [MailService], exports: [MailService] })
export class MailModule {}

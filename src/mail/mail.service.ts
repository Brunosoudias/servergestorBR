import { Global, Inject, Injectable, Logger, Module } from "@nestjs/common";
import { createTransport, type Transporter } from "nodemailer";
import { ENV, type Env } from "../config/env";

const maskEmail = (e: string) => e.replace(/^(.)[^@]*(@.*)$/, "$1***$2");
const SENDGRID_URL = "https://api.sendgrid.com/v3/mail/send";
const SENDGRID_TIMEOUT_MS = 10_000;

/** "Gestor Br <nao-responder@dominio>" → { name, email } */
const parseAddress = (from: string) => {
  const m = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return m ? { email: m[2], ...(m[1] ? { name: m[1].replace(/^"|"$/g, "") } : {}) } : { email: from.trim() };
};

@Injectable()
export class MailService {
  private readonly log = new Logger("Mail");
  private readonly transport: Transporter | null;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.transport = env.mailEnabled && !env.sendgridApiKey && env.smtp ? createTransport({ host: env.smtp.host, port: env.smtp.port, secure: env.smtp.port === 465, auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass } : undefined }) : null;
  }

  /** Envio real ligado (MAIL_ENABLED=true) e com SendGrid ou SMTP configurado. */
  get enabled() {
    return this.env.mailEnabled && (!!this.env.sendgridApiKey || !!this.transport);
  }

  async send(to: string, subject: string, text: string) {
    if (!this.enabled) {
      // O corpo leva tokens de redefinição/convite: só aparece no log em desenvolvimento.
      const body = ["development", "test"].includes(process.env.NODE_ENV ?? "development") ? `\n${text}` : "";
      const why = this.env.mailEnabled ? "SendGrid/SMTP não configurado" : "envio desativado (MAIL_ENABLED=false)";
      this.log.warn(`[e-mail não enviado — ${why}] Para: ${maskEmail(to)} · Assunto: ${subject}${body}`);
      return;
    }
    try {
      if (this.env.sendgridApiKey) await this.sendViaSendgrid(this.env.sendgridApiKey, to, subject, text);
      else await this.transport!.sendMail({ from: this.env.mailFrom, to, subject, text });
    } catch (e) { this.log.error(`Falha ao enviar e-mail para ${maskEmail(to)}: ${(e as Error).message}`); }
  }

  private async sendViaSendgrid(apiKey: string, to: string, subject: string, text: string) {
    const res = await fetch(SENDGRID_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(SENDGRID_TIMEOUT_MS),
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: parseAddress(this.env.mailFrom),
        subject,
        content: [{ type: "text/plain", value: text }],
        // Links de redefinição e convite carregam o token: não podem passar pelo redirecionador de cliques do SendGrid.
        tracking_settings: { click_tracking: { enable: false, enable_text: false }, open_tracking: { enable: false } },
      }),
    });
    if (!res.ok) throw new Error(`SendGrid ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  }

  passwordReset(to: string, name: string, token: string) {
    return this.send(to, "Gestor Br — redefinição de senha", `Olá, ${name}.\n\nPara criar uma nova senha no Gestor Br, acesse (válido por 1 hora):\n${this.env.webUrl}/reset-password?token=${token}\n\nSe não foi você, ignore este e-mail.`);
  }

  passwordChanged(to: string, name: string) {
    const when = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
    return this.send(to, "Gestor Br — sua senha foi alterada", `Olá, ${name}.\n\nA senha da sua conta no Gestor Br foi alterada em ${when}, e todas as sessões abertas foram encerradas.\n\nSe não foi você, redefina a senha agora em ${this.env.webUrl}/forgot-password e avise o administrador da sua empresa.`);
  }

  newDeviceLogin(to: string, name: string, userAgent: string, ip: string) {
    const when = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
    return this.send(to, "Gestor Br — novo acesso à sua conta", `Olá, ${name}.\n\nSua conta no Gestor Br foi acessada por um dispositivo novo em ${when}.\n\nDispositivo: ${userAgent.slice(0, 160) || "desconhecido"}\nIP: ${ip}\n\nSe foi você, ignore este e-mail. Se não reconhece este acesso, redefina a senha agora em ${this.env.webUrl}/forgot-password e ative a verificação em duas etapas em Configurações > Segurança.`);
  }

  mfaRecoveryUsed(to: string, name: string, left: number) {
    return this.send(to, "Gestor Br — código de recuperação usado", `Olá, ${name}.\n\nUm código de recuperação da verificação em duas etapas acabou de ser usado na sua conta. Restam ${left} código(s).\n\nSe não foi você, redefina a senha agora em ${this.env.webUrl}/forgot-password. Para gerar novos códigos, acesse Configurações > Segurança.`);
  }

  invite(to: string, company: string, inviter: string, token: string) {
    return this.send(to, `Gestor Br — convite para ${company}`, `${inviter} convidou você para acessar ${company} no Gestor Br.\n\nDefina sua senha para entrar (válido por 7 dias):\n${this.env.webUrl}/reset-password?token=${token}`);
  }

  saleReceipt(to: string, name: string, sale: { number: string; date: Date; total: number; items: string[] }) {
    const when = sale.date.toLocaleString("pt-BR");
    const total = sale.total.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
    return this.send(to, `Comprovante da venda #${sale.number}`, `Olá, ${name}.\n\nSegue o comprovante da venda #${sale.number} em ${when}.\n\n${sale.items.join("\n")}\n\nTotal: ${total}\n\nEste comprovante não tem valor fiscal.`);
  }
}

@Global()
@Module({ providers: [MailService], exports: [MailService] })
export class MailModule {}

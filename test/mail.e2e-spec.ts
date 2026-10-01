import { loadEnv } from "../src/config/env";
import { MailService } from "../src/mail/mail.service";

describe("MailService (SendGrid)", () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  const service = (MAIL_ENABLED = "true") => new MailService(loadEnv({ ...process.env, MAIL_ENABLED, SENDGRID_API_KEY: "SG.test", MAIL_FROM: "Gestor Br <nao-responder@gestorbr.com.br>", WEB_URL: "https://app.gestorbr.com.br" }));

  it("com MAIL_ENABLED desligado não chama o SendGrid, mesmo com a chave configurada", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const off = service("false");
    expect(off.enabled).toBe(false);
    await off.passwordReset("ana@empresa.com.br", "Ana", "tok123");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(service().enabled).toBe(true);
  });

  it("envia a redefinição de senha pela API do SendGrid, sem rastrear o link com o token", async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response(null, { status: 202 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    await service().passwordReset("ana@empresa.com.br", "Ana", "tok123");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.sendgrid.com/v3/mail/send");
    expect(init.headers.Authorization).toBe("Bearer SG.test");
    const body = JSON.parse(init.body);
    expect(body.personalizations).toEqual([{ to: [{ email: "ana@empresa.com.br" }] }]);
    expect(body.from).toEqual({ email: "nao-responder@gestorbr.com.br", name: "Gestor Br" });
    expect(body.subject).toBe("Gestor Br — redefinição de senha");
    expect(body.content[0].value).toContain("https://app.gestorbr.com.br/reset-password?token=tok123");
    expect(body.tracking_settings.click_tracking).toEqual({ enable: false, enable_text: false });
  });

  it("não derruba o fluxo quando o SendGrid recusa o envio", async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
    await expect(service().passwordChanged("ana@empresa.com.br", "Ana")).resolves.toBeUndefined();
  });

  it("com o envio ligado, exige SendGrid ou SMTP e um remetente real em produção", () => {
    expect(() => loadEnv({ NODE_ENV: "production", SECRETS_KEY: "a".repeat(64), WEB_ORIGINS: "https://app.gestorbr.com.br" })).not.toThrow();
    const prod = { NODE_ENV: "production", SECRETS_KEY: "a".repeat(64), WEB_ORIGINS: "https://app.gestorbr.com.br", MAIL_ENABLED: "true" };
    expect(() => loadEnv(prod)).toThrow(/SENDGRID_API_KEY/);
    expect(() => loadEnv({ ...prod, SENDGRID_API_KEY: "SG.x" })).toThrow(/MAIL_FROM/);
    expect(() => loadEnv({ ...prod, SENDGRID_API_KEY: "SG.x", MAIL_FROM: "Gestor Br <nao-responder@gestorbr.com.br>" })).not.toThrow();
  });
});

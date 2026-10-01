import { formatCnpj } from "../src/common/cnpj";

/** CNPJ válido e aleatório: o banco de testes persiste entre execuções e o CNPJ é único por empresa. */
export function randomCnpj() {
  const d = Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)).concat([0, 0, 0, 1]);
  const dv = (base: number[]) => {
    const w = base.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const r = base.reduce((s, n, i) => s + n * w[i], 0) % 11;
    return r < 2 ? 0 : 11 - r;
  };
  d.push(dv(d));
  d.push(dv(d));
  return d.join("");
}

export const randomCnpjFormatted = () => formatCnpj(randomCnpj());

type MailImpl = Record<string, (...args: never[]) => Promise<unknown>>;

/** MailService falso: métodos não informados viram no-op, então e-mails novos não quebram as suítes. Por padrão finge o envio ligado. */
export function mailMock(impl: MailImpl = {}, enabled = true) {
  return new Proxy(impl, {
    get: (target, key) => key === "enabled" ? enabled : (typeof key !== "string" || key === "then" ? undefined : (target[key] ?? (async () => undefined))),
  });
}

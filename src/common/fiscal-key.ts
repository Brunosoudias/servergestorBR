export function buildAccessKey(p: { cnpj: string; model: 55 | 65; series: string; number: number; date: Date; code: number }) {
  const body = `35${String(p.date.getFullYear() % 100).padStart(2, "0")}${String(p.date.getMonth() + 1).padStart(2, "0")}${p.cnpj.replace(/\D/g, "").padStart(14, "0").slice(0, 14)}${p.model}${p.series.replace(/\D/g, "").padStart(3, "0").slice(0, 3)}${String(p.number).padStart(9, "0")}1${String(p.code).padStart(8, "0")}`;
  let sum = 0, w = 2;
  for (let i = body.length - 1; i >= 0; i--) { sum += Number(body[i]) * w; w = w === 9 ? 2 : w + 1; }
  const r = sum % 11;
  return body + (r < 2 ? 0 : 11 - r);
}


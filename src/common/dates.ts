export interface Period { from: Date; to: Date; prevFrom: Date; prevTo: Date; }

export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

export function parsePeriod(range = "30d", now = new Date()): Period {
  let from: Date; let to: Date;
  const custom = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/.exec(range);
  if (custom) {
    const [a, b] = [new Date(`${custom[1]}T00:00:00`), new Date(`${custom[2]}T00:00:00`)];
    from = startOfDay(a <= b ? a : b); to = endOfDay(a <= b ? b : a);
  } else {
    const days = range === "hoje" || range === "today" ? 1 : range === "7d" ? 7 : range === "90d" ? 90 : 30;
    to = endOfDay(now); from = startOfDay(addDays(now, -(days - 1)));
  }
  const len = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000));
  return { from, to, prevFrom: addDays(from, -len), prevTo: new Date(from.getTime() - 1) };
}

const MONTHS = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
export const monthLabel = (d: Date) => MONTHS[d.getMonth()];
export function lastMonths(n: number, now = new Date()) {
  return Array.from({ length: n }, (_, i) => {
    const ref = new Date(now.getFullYear(), now.getMonth() - (n - 1 - i), 1);
    return { label: monthLabel(ref), from: ref, to: new Date(ref.getFullYear(), ref.getMonth() + 1, 0, 23, 59, 59, 999) };
  });
}
export const pct = (cur: number, prev: number) => (prev === 0 ? (cur === 0 ? 0 : 100) : Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10);

export const todayDate = (now = new Date()) => new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));

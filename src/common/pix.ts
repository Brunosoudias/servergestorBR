const f = (id: string, value: string) => `${id}${String(value.length).padStart(2, "0")}${value}`;
const ascii = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, "").toUpperCase();

export function crc16(payload: string) {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

export function buildPixPayload({ key, name, city, amount, txid = "***" }: { key: string; name: string; city: string; amount?: number; txid?: string }) {
  const account = f("00", "br.gov.bcb.pix") + f("01", key);
  const body =
    f("00", "01") + f("26", account) + f("52", "0000") + f("53", "986") +
    (amount ? f("54", amount.toFixed(2)) : "") +
    f("58", "BR") + f("59", ascii(name).slice(0, 25)) + f("60", ascii(city).slice(0, 15)) +
    f("62", f("05", txid.replace(/[^A-Za-z0-9]/g, "").slice(0, 25) || "***")) + "6304";
  return body + crc16(body);
}

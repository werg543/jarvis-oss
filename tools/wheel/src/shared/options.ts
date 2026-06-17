export function dteForExpiry(expiry: string, from: number = Date.now()): number | null {
  let d: Date | null = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
    d = new Date(`${expiry}T16:00:00`);
  } else {
    const m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(expiry);
    if (m) {
      const yr = m[3] ? (Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3])) : new Date(from).getFullYear();
      d = new Date(yr, Number(m[1]) - 1, Number(m[2]), 16);
      if (!m[3] && d.getTime() < from - 86_400_000) d = new Date(yr + 1, Number(m[1]) - 1, Number(m[2]), 16);
    }
  }
  if (!d || Number.isNaN(d.getTime())) return null;
  return Math.round((d.getTime() - from) / 86_400_000);
}

export function dteFromIso(expiry: string, from: number = Date.now()): number {
  const ms = new Date(expiry + 'T00:00:00').getTime() - from;
  return Math.max(0, Math.round(ms / 86_400_000));
}

export function legKey(p: {
  symbol: string;
  type: string;
  strike: number;
  expiry: string;
}): string {
  return `${p.symbol.toUpperCase()}|${p.type}|${p.strike}|${p.expiry}`;
}

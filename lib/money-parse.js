export function parseMoneyValue(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : NaN;
  }
  let raw = String(value ?? '').trim();
  if (!raw) return NaN;
  const negativeParen = /^\(.*\)$/.test(raw);
  // Remove parentheses for further parsing
  raw = raw.replace(/[()]/g, '');
  // Strip everything except digits, comma, dot, minus
  // Keep digits, comma, dot, minus sign
  raw = raw.replace(/[^0-9,.\-]/g, '');
  if (!raw) return NaN;
  // Handle multiple minus signs: keep only leading minus
  // Remove any minus not at start
  const hasLeadingMinus = raw.startsWith('-');
  raw = raw.replace(/-/g, '');
  if (hasLeadingMinus) raw = '-' + raw;

  const lastComma = raw.lastIndexOf(',');
  const lastDot = raw.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      raw = raw.replace(/\./g, '').replace(',', '.');
    } else {
      raw = raw.replace(/,/g, '');
    }
  } else if (lastComma >= 0 && lastDot < 0) {
    const decimals = raw.length - lastComma - 1;
    raw = decimals > 0 && decimals <= 2 ? raw.replace(',', '.') : raw.replace(/,/g, '');
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return NaN;
  return negativeParen ? -Math.abs(n) : n;
}

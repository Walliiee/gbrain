/** Shared kill switch: also stops reconciliation/redirect during offline rollback. */
export function isFactRepairDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['off', '0', 'false', 'disabled'].includes((env.GBRAIN_FACT_REPAIR ?? '').trim().toLowerCase());
}

/** Decimal equality without converting a NUMERIC column through an imprecise JS number. */
export function exactDecimal(value: string | number): string | null {
  const m = String(value).match(/^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
  if (!m) return null;
  const exponent = Number(m[4] ?? 0) - (m[3]?.length ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10000) return null;
  let digits = (m[2]! + (m[3] ?? '')).replace(/^0+/, '');
  if (!digits) return '0';
  let exp = exponent;
  while (digits.endsWith('0')) { digits = digits.slice(0, -1); exp++; }
  return `${m[1] === '-' ? '-' : ''}${digits}e${exp}`;
}

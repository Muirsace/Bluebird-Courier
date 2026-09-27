/** 数字展示：整数一律千分位分组（236929 → "236,929"），不做 K/M 缩写。 */

/** 千分位分组的整数；缺值或非法值返回 "—"。 */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US');
}

/** 变化量文案：+142 / -12 / 0；无有效变化量时返回 null。 */
export function formatDelta(delta: number | null | undefined): string | null {
  if (delta === null || delta === undefined || !Number.isFinite(delta)) return null;
  if (delta === 0) return '0';
  return `${delta > 0 ? '+' : '-'}${formatCount(Math.abs(delta))}`;
}

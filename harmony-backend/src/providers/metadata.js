export function releaseDate(value) {
  if (value === null || value === undefined || value === '' || value === 0) return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value < 1e11 ? value * 1000 : value);
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
  }
  if (typeof value !== 'string') return '';
  const match = value.trim().match(/^(\d{4})[-/](\d{2})[-/](\d{2})(?:$|[T\s])/);
  if (!match) return '';
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(date);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : '';
}

export function statisticCount(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

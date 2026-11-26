export function normalizeIndianPhone10Digits(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  const raw = String(input).trim();
  if (raw.length === 0) return undefined;

  const digits = raw.replace(/\D/g, '');
  if (digits.length < 10) return undefined;

  // For India-only support: keep the last 10 digits (drops +91/0 prefixes).
  return digits.slice(-10);
}

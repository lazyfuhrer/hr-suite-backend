import crypto from 'crypto';

import type { SalaryComponent } from '../models/SalaryComponent';

type FinanceItem = { name: string; amount: number };

const MAX_CODE_LEN = 50;

const toUpperSnake = (input: string): string => {
  return String(input || '')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .toUpperCase();
};

const shortHash = (input: string): string =>
  crypto.createHash('sha1').update(String(input)).digest('hex').slice(0, 6).toUpperCase();

export const KNOWN_FINANCE_CODES = new Set([
  'BASIC',
  'HRA',
  'CONVEYANCE_ALLOWANCE',
  'PF',
  'PROFESSIONAL_TAX',
  'INCOME_TAX_TDS',
  'ESI',
]);

export function financeItemToComponentCode(params: {
  kind: 'EARNING' | 'DEDUCTION';
  name: string;
}): string {
  const base = toUpperSnake(params.name);
  const prefix = params.kind === 'DEDUCTION' ? 'D_' : 'E_';
  let code = `${prefix}${base || 'ITEM'}`;

  if (KNOWN_FINANCE_CODES.has(code)) {
    code = `${code}_${shortHash(params.name)}`;
  }

  if (code.length > MAX_CODE_LEN) {
    code = code.slice(0, MAX_CODE_LEN - 7) + '_' + shortHash(params.name);
  }

  return code;
}

export async function ensureFinanceItemComponent(params: {
  trx: any;
  org_id: string;
  kind: 'EARNING' | 'DEDUCTION';
  name: string;
  display_order: number;
  queryByCode: (trx: any, org_id: string, code: string) => Promise<SalaryComponent | undefined>;
  insertComponent: (
    trx: any,
    input: {
      org_id: string;
      code: string;
      name: string;
      type: SalaryComponent['type'];
      display_order: number;
    },
  ) => Promise<SalaryComponent>;
}): Promise<SalaryComponent> {
  const desiredType: SalaryComponent['type'] =
    params.kind === 'DEDUCTION' ? 'DEDUCTION' : 'ALLOWANCE';
  const baseCode = financeItemToComponentCode({ kind: params.kind, name: params.name });

  const existing = await params.queryByCode(params.trx, params.org_id, baseCode);
  if (existing) return existing;

  // If a collision occurs at DB-level due to concurrent inserts, caller should handle UniqueViolationError
  return params.insertComponent(params.trx, {
    org_id: params.org_id,
    code: baseCode,
    name: params.name.trim(),
    type: desiredType,
    display_order: params.display_order,
  });
}

export function normalizeFinanceItems(input: unknown): Array<{ name: string; amount: number }> {
  const items = Array.isArray(input) ? (input as FinanceItem[]) : [];
  return items
    .map((i) => ({
      name: String((i as any)?.name || '').trim(),
      amount: Number((i as any)?.amount || 0),
    }))
    .filter((i) => i.name && Number.isFinite(i.amount) && i.amount > 0);
}

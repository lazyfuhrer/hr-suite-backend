export const REIMBURSEMENT_TYPES = ['TRAVEL', 'MEAL', 'MEDICAL', 'OTHER'] as const;

export type ReimbursementType = (typeof REIMBURSEMENT_TYPES)[number];

export const REIMBURSEMENT_TYPE_LABELS: Record<ReimbursementType, string> = {
  TRAVEL: 'Travel',
  MEAL: 'Meal',
  MEDICAL: 'Medical',
  OTHER: 'Other',
};

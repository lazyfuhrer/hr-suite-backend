export const REIMBURSEMENT_PAYMENT_STATUSES = ['UNPAID', 'PAID'] as const;

export type ReimbursementPaymentStatus = (typeof REIMBURSEMENT_PAYMENT_STATUSES)[number];

export const REIMBURSEMENT_PAYMENT_STATUS_LABELS: Record<ReimbursementPaymentStatus, string> = {
  UNPAID: 'Unpaid',
  PAID: 'Paid',
};

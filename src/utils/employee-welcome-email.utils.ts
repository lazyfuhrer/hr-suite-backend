import { User } from '../models/User';

export function hasEmployeeWelcomeEmailBeenSent(
  user: { employee_welcome_email_sent_at?: Date | string | null } | null | undefined,
): boolean {
  return user?.employee_welcome_email_sent_at != null;
}

/**
 * Row lock + fields needed to decide whether to send employee welcome email (idempotent send).
 */
export async function loadUserForWelcomeEmailLock(
  trx: any,
  userId: string,
): Promise<
  | Pick<
      User,
      | 'id'
      | 'employee_welcome_email_sent_at'
      | 'official_email'
      | 'first_name'
      | 'last_name'
      | 'org_id'
      | 'must_change_password'
      | 'role'
    >
  | undefined
> {
  const row = await User.query(trx)
    .findById(userId)
    .forUpdate()
    .select(
      'id',
      'employee_welcome_email_sent_at',
      'official_email',
      'first_name',
      'last_name',
      'org_id',
      'must_change_password',
      'role',
    );
  return row as any;
}

export async function markEmployeeWelcomeEmailSent(
  trx: any | undefined,
  userId: string,
): Promise<void> {
  const q = trx ? User.query(trx) : User.query();
  await q.patchAndFetchById(userId, {
    employee_welcome_email_sent_at: new Date().toISOString(),
  } as Partial<User>);
}

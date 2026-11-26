import { User } from '../models/User';
import { revokeTenantRefreshTokensForUser } from '../services/tenant-auth.service';

/**
 * Mark users' sessions invalidated and revoke their tenant refresh tokens.
 * Access JWTs issued before sessions_invalidated_at are rejected in authenticateTenant.
 */
export async function invalidateTenantSessionsForUsers(
  orgId: string,
  userIds: string[],
): Promise<void> {
  const uniqueIds = [...new Set(userIds.filter(Boolean))];
  if (uniqueIds.length === 0) {
    return;
  }

  const now = new Date();
  await User.query()
    .patch({ sessions_invalidated_at: now })
    .where('org_id', orgId)
    .whereIn('id', uniqueIds)
    .whereNull('deleted_at');

  await Promise.all(uniqueIds.map((userId) => revokeTenantRefreshTokensForUser(userId, orgId)));
}

export async function invalidateTenantSessionsForDepartment(
  orgId: string,
  departmentId: string,
): Promise<void> {
  const members = await User.query()
    .select('id')
    .where({ org_id: orgId, department_id: departmentId })
    .whereNull('deleted_at');

  await invalidateTenantSessionsForUsers(
    orgId,
    members.map((member) => member.id),
  );
}

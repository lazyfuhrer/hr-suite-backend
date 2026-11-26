import { z } from 'zod';
import { createHash } from 'crypto';

import { UserDeviceToken } from '../../models/UserDeviceToken';
import { sendFcmToTokens } from './fcm.service';
import { logger } from '../../config/logger';
import { NotificationEventLog } from '../../models/NotificationEventLog';
import { User } from '../../models/User';
import { ATTENDANCE_ACTIVE_EMPLOYEE_STATUSES } from '../../constants/user-status';

export const notificationTriggerSchema = z.object({
  event: z.string().min(1),
  scope: z.enum(['user', 'org', 'tokens']),
  userIds: z.array(z.string().uuid()).optional(),
  orgId: z.string().uuid().optional(),
  tokens: z.array(z.string().min(1)).optional(),
  title: z.string().min(1).optional(),
  body: z.string().min(1).optional(),
  data: z.record(z.string(), z.string()).optional(),
  link: z.string().min(1).optional(),
});

export type NotificationTriggerInput = z.infer<typeof notificationTriggerSchema>;

function buildDefaultNotificationForEvent(event: string): { title: string; body: string } {
  // Minimal default behavior; callers can override with title/body.
  return { title: 'Notification', body: event };
}

function normalizeUserIds(ids: string[] | undefined): string[] {
  const raw = ids ?? [];
  return Array.from(new Set(raw.map((id) => String(id ?? '').trim()).filter(Boolean)));
}

/** FCM data payloads require string values. */
function buildFcmData(
  event: string,
  link: string | undefined,
  data: Record<string, string> | undefined,
): Record<string, string> {
  const merged: Record<string, unknown> = {
    event,
    ...(link ? { link } : {}),
    ...(data ?? {}),
  };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === null) continue;
    out[k] = String(v);
  }
  return out;
}

async function resolveTokens(input: NotificationTriggerInput): Promise<string[]> {
  if (input.scope === 'tokens') {
    return input.tokens ?? [];
  }

  if (input.scope === 'user') {
    const ids = normalizeUserIds(input.userIds);
    if (ids.length === 0) return [];

    const rows = await UserDeviceToken.query()
      .alias('udt')
      .select('udt.token', 'udt.platform')
      .innerJoin('users as u', 'u.id', 'udt.user_id')
      .whereIn('udt.user_id', ids)
      .where('udt.enabled', true)
      .whereIn('u.status', ATTENDANCE_ACTIVE_EMPLOYEE_STATUSES as readonly string[])
      .whereNull('u.deleted_at');
    return rows.map((r) => r.token);
  }

  // org scope
  if (!input.orgId) return [];
  const rows = await UserDeviceToken.query()
    .alias('udt')
    .select('udt.token')
    .innerJoin('users as u', 'u.id', 'udt.user_id')
    .where('udt.org_id', input.orgId)
    .where('udt.enabled', true)
    .whereIn('u.status', ATTENDANCE_ACTIVE_EMPLOYEE_STATUSES as readonly string[])
    .whereNull('u.deleted_at');
  return rows.map((r) => r.token);
}

export async function dispatchNotificationEvent(input: NotificationTriggerInput) {
  const userScopeRecipientCount =
    input.scope === 'user' ? normalizeUserIds(input.userIds).length : 0;
  const tokens = await resolveTokens(input);

  if (input.scope === 'user' && tokens.length === 0 && userScopeRecipientCount > 0) {
    logger.warn(
      { event: input.event, userIdCount: userScopeRecipientCount },
      'No enabled FCM tokens for targeted users',
    );
  }

  const defaults = buildDefaultNotificationForEvent(input.event);
  const title = input.title ?? defaults.title;
  const body = input.body ?? defaults.body;

  const effectiveUserIds = input.scope === 'user' ? normalizeUserIds(input.userIds) : [];

  const inferOrgId = async (): Promise<string | null> => {
    if (input.orgId) return input.orgId;

    if (input.scope === 'user') {
      if (effectiveUserIds.length === 0) return null;
      const row = await User.query().select('org_id').findById(effectiveUserIds[0]);
      return (row as any)?.org_id ?? null;
    }

    if (input.scope === 'tokens') {
      const rawTokens = input.tokens ?? [];
      if (rawTokens.length === 0) return null;
      const row = await UserDeviceToken.query()
        .select('org_id')
        .whereIn('token', rawTokens)
        .whereNotNull('org_id')
        .first();
      return (row as any)?.org_id ?? null;
    }

    return null;
  };

  try {
    const result = await sendFcmToTokens(tokens, {
      notification: { title, body },
      data: buildFcmData(input.event, input.link, input.data),
    });

    const orgIdForLog = await inferOrgId();
    const responseRows = result.tokens.map((t, idx) => {
      const r = result.responses[idx];
      const error = r?.error as any;
      return {
        tokenHash: createHash('sha256').update(t).digest('hex'),
        success: Boolean(r?.success),
        ...(error?.code ? { errorCode: String(error.code) } : {}),
        ...(error?.message ? { errorMessage: String(error.message) } : {}),
      };
    });

    try {
      await NotificationEventLog.query().insert({
        org_id: orgIdForLog,
        event: input.event,
        scope: input.scope,
        title,
        body,
        link: input.link ?? null,
        data: (input.data ?? {}) as any,
        target_user_ids: effectiveUserIds,
        target_org_id: input.scope === 'org' ? (input.orgId ?? null) : null,
        token_count: result.tokens.length,
        success_count: result.successCount,
        failure_count: result.failureCount,
        invalid_tokens: result.invalidTokens,
        responses: responseRows,
        error: null,
      });
    } catch (logErr) {
      logger.warn({ err: logErr, event: input.event }, 'Failed to write notification event log');
    }

    return result;
  } catch (err) {
    const orgIdForLog = await inferOrgId().catch(() => null);
    try {
      await NotificationEventLog.query().insert({
        org_id: orgIdForLog,
        event: input.event,
        scope: input.scope,
        title,
        body,
        link: input.link ?? null,
        data: (input.data ?? {}) as any,
        target_user_ids: effectiveUserIds,
        target_org_id: input.scope === 'org' ? (input.orgId ?? null) : null,
        token_count: tokens.length,
        success_count: 0,
        failure_count: tokens.length,
        invalid_tokens: [],
        responses: [],
        error:
          err instanceof Error
            ? { name: err.name, message: err.message, stack: err.stack }
            : { message: String(err) },
      });
    } catch (logErr) {
      logger.warn({ err: logErr }, 'Failed to write notification event log');
    }
    throw err;
  }
}

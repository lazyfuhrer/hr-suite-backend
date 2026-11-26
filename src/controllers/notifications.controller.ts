import type { NextFunction, Request, Response } from 'express';

import { env } from '../config/env';
import { Organization } from '../models/Organization';
import { UserDeviceToken } from '../models/UserDeviceToken';
import { User } from '../models/User';
import { getOrganizationAccessDenialMessage } from '../utils/organization-expiry.utils';
import { NotificationEventLog } from '../models/NotificationEventLog';
import {
  dispatchNotificationEvent,
  notificationTriggerSchema,
} from '../services/notifications/notification-dispatcher.service';
import {
  getNotificationSettings,
  upsertNotificationSettings,
} from '../services/notifications/notification-settings.service';
import { updateNotificationSettingsSchema } from '../validators';

export class NotificationsController {
  static async listLogs(req: Request, res: Response): Promise<Response> {
    if (!req.user || !req.orgId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const event = typeof req.query.event === 'string' ? req.query.event.trim() : undefined;
    const pageRaw = typeof req.query.page === 'string' ? Number(req.query.page) : 1;
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : 25;

    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 25, 1), 100);
    const page = Math.max(Number.isFinite(pageRaw) ? Math.floor(pageRaw) : 1, 1);

    const query = NotificationEventLog.query()
      .where('org_id', req.orgId)
      .modify((qb) => {
        if (event) qb.where('event', event);
      })
      .orderBy('created_at', 'desc');

    const countRow = await query
      .clone()
      .clearSelect()
      .clearOrder()
      .countDistinct('id as count')
      .first();
    const total = Number((countRow as { count?: string | number } | undefined)?.count ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(page, totalPages);
    const offset = (safePage - 1) * limit;

    const rows = await query.clone().limit(limit).offset(offset);

    return res.json({
      data: rows,
      pagination: {
        page: safePage,
        limit,
        total,
        totalPages,
      },
    });
  }

  static async getLog(req: Request, res: Response): Promise<Response> {
    if (!req.user || !req.orgId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    const id = String(req.params.id ?? '').trim();
    if (!id) {
      return res.status(400).json({ message: 'id is required' });
    }

    const row = await NotificationEventLog.query().findById(id);
    if (!row || (row as any).org_id !== req.orgId) {
      return res.status(404).json({ message: 'Notification log not found' });
    }

    return res.json({ data: row });
  }

  static async getSettings(req: Request, res: Response): Promise<Response> {
    if (!req.user || !req.orgId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const settings = await getNotificationSettings(req.orgId);
    return res.json({ message: 'Notification settings fetched successfully', data: settings });
  }

  static async updateSettings(req: Request, res: Response): Promise<Response> {
    if (!req.user || !req.orgId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = updateNotificationSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    if (Object.keys(parsed.data).length === 0) {
      return res.status(400).json({ message: 'No settings provided' });
    }

    const updated = await upsertNotificationSettings(req.orgId, parsed.data);

    return res.json({ message: 'Notification settings updated successfully', data: updated });
  }

  static async registerDeviceToken(req: Request, res: Response): Promise<Response> {
    if (!req.user || !req.orgId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { token, platform, deviceId } = (req.body ?? {}) as {
      token?: string;
      platform?: string;
      deviceId?: string;
    };

    if (!token || typeof token !== 'string' || token.trim().length === 0) {
      return res.status(400).json({ message: 'token is required' });
    }
    if (!platform || typeof platform !== 'string' || !['apns', 'gcm', 'web'].includes(platform)) {
      return res.status(400).json({ message: 'platform must be one of apns|gcm|web' });
    }

    const now = new Date();
    const trimmedToken = token.trim();

    // Enforce one token row per user (DB unique on user_id).
    // If the same token was previously associated to another user, remove it first
    // so the token unique constraint does not block the upsert.
    await UserDeviceToken.query()
      .where('token', trimmedToken)
      .whereNot('user_id', req.user.id)
      .delete();

    await UserDeviceToken.query()
      .insert({
        user_id: req.user.id,
        org_id: req.orgId,
        token: trimmedToken,
        platform,
        device_id: deviceId ?? null,
        enabled: true,
        last_seen_at: now,
      })
      .onConflict('user_id')
      .merge({
        token: trimmedToken,
        org_id: req.orgId,
        platform,
        device_id: deviceId ?? null,
        enabled: true,
        last_seen_at: now,
        updated_at: now,
      });

    return res.json({ message: 'Device token registered' });
  }

  static async trigger(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    const internalKey = req.headers['x-internal-key'];
    const expected = env.INTERNAL_NOTIFICATIONS_KEY;

    const isInternalCaller = Boolean(expected && internalKey === expected);
    const isClientCaller = !isInternalCaller;

    if (isClientCaller) {
      // Client-callable mode: requires tenant JWT (populated by authenticateTenantOptional when Bearer header exists)
      if (!req.user || !req.orgId) {
        return res.status(401).json({ message: 'Unauthorized' });
      }
    }

    const parsed = notificationTriggerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    // Enforce required targeting per scope
    if (isInternalCaller) {
      if (
        parsed.data.scope === 'user' &&
        (!parsed.data.userIds || parsed.data.userIds.length === 0)
      ) {
        return res.status(400).json({ message: 'userIds is required when scope=user' });
      }
      if (parsed.data.scope === 'org' && !parsed.data.orgId) {
        return res.status(400).json({ message: 'orgId is required when scope=org' });
      }
      if (
        parsed.data.scope === 'tokens' &&
        (!parsed.data.tokens || parsed.data.tokens.length === 0)
      ) {
        return res.status(400).json({ message: 'tokens is required when scope=tokens' });
      }
    } else {
      // Client mode policies:
      // - disallow tokens targeting
      // - allow user targeting for all roles (same org only)
      // - allow org broadcast only for admin/hr/manager (force orgId=req.orgId)
      if (parsed.data.scope === 'tokens') {
        return res.status(403).json({ message: 'scope=tokens is not allowed for client calls' });
      }
      if (
        parsed.data.scope === 'user' &&
        (!parsed.data.userIds || parsed.data.userIds.length === 0)
      ) {
        return res.status(400).json({ message: 'userIds is required when scope=user' });
      }
      if (parsed.data.scope === 'org') {
        const role = req.user!.role;
        if (!['admin', 'hr', 'manager'].includes(role)) {
          return res.status(403).json({ message: 'scope=org is not allowed for this role' });
        }
      }
    }

    try {
      const input = parsed.data;

      if (isClientCaller) {
        if (input.scope === 'user') {
          const userIds = input.userIds ?? [];
          // Ensure all targeted users belong to the caller's org
          const rows = await User.query()
            .select('id')
            .whereIn('id', userIds)
            .where('org_id', req.orgId!);
          if (rows.length !== userIds.length) {
            return res
              .status(403)
              .json({ message: 'One or more userIds are outside your organization' });
          }
        }
      }

      const effectiveInput = isClientCaller
        ? input.scope === 'org'
          ? { ...input, orgId: req.orgId! }
          : input.scope === 'user'
            ? { ...input, orgId: req.orgId! }
            : input
        : input;

      if (effectiveInput.scope === 'org' && effectiveInput.orgId) {
        const org = await Organization.query()
          .findById(effectiveInput.orgId)
          .select('subscription_status', 'deleted_at', 'expires_at');
        const denialMessage = getOrganizationAccessDenialMessage(org);
        if (denialMessage) {
          return res.status(403).json({ message: denialMessage });
        }
      }

      const result = await dispatchNotificationEvent(effectiveInput);

      return res.json({
        successCount: result.successCount,
        failureCount: result.failureCount,
        invalidTokens: result.invalidTokens,
      });
    } catch (error) {
      next(error);
    }
  }
}

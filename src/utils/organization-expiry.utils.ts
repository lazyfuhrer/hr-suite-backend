import type { Response } from 'express';

const DEFAULT_ORG_VALIDITY_MONTHS = 6;

export const ORGANIZATION_INACTIVE_MESSAGE = 'Organization is inactive';

/** Add calendar months in UTC (handles month-end overflow). */
export const addMonthsUtc = (base: Date, months: number): Date => {
  const year = base.getUTCFullYear();
  const month = base.getUTCMonth();
  const day = base.getUTCDate();
  const hours = base.getUTCHours();
  const minutes = base.getUTCMinutes();
  const seconds = base.getUTCSeconds();
  const ms = base.getUTCMilliseconds();

  const targetMonthIndex = month + months;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const normalizedMonth = ((targetMonthIndex % 12) + 12) % 12;
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  const safeDay = Math.min(day, lastDayOfTargetMonth);

  return new Date(Date.UTC(targetYear, normalizedMonth, safeDay, hours, minutes, seconds, ms));
};

export const getDefaultOrganizationExpiresAt = (createdAt?: Date): Date =>
  addMonthsUtc(createdAt ?? new Date(), DEFAULT_ORG_VALIDITY_MONTHS);

export const isOrganizationExpired = (expiresAt: string | Date | null | undefined): boolean => {
  if (expiresAt == null) {
    return false;
  }
  const expiryMs = new Date(expiresAt).getTime();
  if (Number.isNaN(expiryMs)) {
    return false;
  }
  return Date.now() > expiryMs;
};

export const ORGANIZATION_EXPIRED_MESSAGE = 'Organization has expired';

export type OrganizationAccessSnapshot = {
  subscription_status?: string;
  deleted_at?: string | null;
  expires_at?: string | Date | null;
};

export const getOrganizationAccessDenialMessage = (
  org: OrganizationAccessSnapshot | null | undefined,
): string | null => {
  if (!org || org.subscription_status === 'INACTIVE' || org.deleted_at) {
    return ORGANIZATION_INACTIVE_MESSAGE;
  }
  if (isOrganizationExpired(org.expires_at)) {
    return ORGANIZATION_EXPIRED_MESSAGE;
  }
  return null;
};

export const isOrganizationAccessible = (
  org: OrganizationAccessSnapshot | null | undefined,
): boolean => getOrganizationAccessDenialMessage(org) === null;

export const sendOrganizationAccessDenied = (
  res: Response,
  org: OrganizationAccessSnapshot | null | undefined,
): boolean => {
  const message = getOrganizationAccessDenialMessage(org);
  if (!message) {
    return false;
  }
  res.status(403).json({ message });
  return true;
};

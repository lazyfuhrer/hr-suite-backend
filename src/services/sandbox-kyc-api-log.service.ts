import type { Request } from 'express';

import { SandboxKycApiLog } from '../models/SandboxKycApiLog';
import { logger } from '../config/logger';

export const SANDBOX_KYC_API_KINDS = {
  AADHAAR_OTP: 'aadhaar_otp',
  AADHAAR_VERIFY_OTP: 'aadhaar_verify_otp',
  PAN_VERIFY: 'pan_verify',
  BANK_VERIFY: 'bank_verify',
} as const;

export type SandboxKycApiKind = (typeof SANDBOX_KYC_API_KINDS)[keyof typeof SANDBOX_KYC_API_KINDS];

type RecordInput = {
  orgId: string | null | undefined;
  userId: string;
  apiKind: SandboxKycApiKind;
  httpStatus: number;
  responseBody: Record<string, unknown>;
};

export class SandboxKycApiLogService {
  static async recordSafely(input: RecordInput): Promise<void> {
    try {
      await SandboxKycApiLog.query().insert({
        org_id: input.orgId ?? null,
        user_id: input.userId,
        api_kind: input.apiKind,
        http_status: input.httpStatus,
        response_body: input.responseBody,
      } as any);
    } catch (err) {
      logger.error({ err, sandboxKycLog: input }, 'Failed to persist Sandbox KYC API log');
    }
  }

  /** Records the outgoing JSON body and status for authenticated onboarding KYC calls. */
  static async recordIfUser(
    req: Request,
    apiKind: SandboxKycApiKind,
    httpStatus: number,
    responseBody: Record<string, unknown>,
  ): Promise<void> {
    if (!req.user) {
      return;
    }
    if (!req.user.org_id) {
      return;
    }
    await SandboxKycApiLogService.recordSafely({
      orgId: req.user.org_id,
      userId: req.user.id,
      apiKind,
      httpStatus,
      responseBody,
    });
  }

  static async listForOrgAdmin(params: {
    org_id: string;
    page: number;
    limit: number;
    user_id?: string;
    api_kind?: SandboxKycApiKind;
  }) {
    const { org_id, page, limit, user_id, api_kind } = params;
    const safeLimit = Math.min(Math.max(1, limit), 100);
    const safePage = Math.max(1, page);
    const offset = (safePage - 1) * safeLimit;

    const base = SandboxKycApiLog.query().where('org_id', org_id);
    if (user_id) {
      base.andWhere('user_id', user_id);
    }
    if (api_kind) {
      base.andWhere('api_kind', api_kind);
    }

    const [totalRow, rows] = await Promise.all([
      base.clone().resultSize(),
      base
        .clone()
        .orderBy('created_at', 'desc')
        .offset(offset)
        .limit(safeLimit)
        .select(
          'id',
          'org_id',
          'user_id',
          'api_kind',
          'http_status',
          'response_body',
          'created_at',
        ),
    ]);

    return {
      page: safePage,
      limit: safeLimit,
      total: totalRow,
      total_pages: Math.max(1, Math.ceil(totalRow / safeLimit)),
      items: rows,
    };
  }
}

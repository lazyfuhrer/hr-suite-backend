import type { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { Model } from 'objection';

import { SuperAdmin } from '../../models/SuperAdmin';
import { RefreshToken } from '../../models/RefreshToken';
import { generateToken } from '../../services/jwt.service';
import {
  generateRefreshToken,
  getRefreshTokenExpiresAtIso,
  hashRefreshToken,
} from '../../services/refresh-token.service';

export class AdminAuthController {
  static async login(req: Request, res: Response): Promise<Response> {
    const { email, password } = req.body as { email?: string; password?: string };

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const admin = await SuperAdmin.query().findOne({ email });
    if (!admin) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const passwordMatches = await bcrypt.compare(password, admin.password_hash);
    if (!passwordMatches) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const token = generateToken({
      id: admin.id,
      email: admin.email,
      role: 'super_admin',
      type: 'platform',
    });

    const refreshToken = generateRefreshToken();
    await RefreshToken.query().insert({
      token_hash: hashRefreshToken(refreshToken),
      subject_type: 'platform',
      subject_id: admin.id,
      org_id: null,
      role: 'super_admin',
      expires_at: getRefreshTokenExpiresAtIso(),
    });

    return res.json({ message: 'Login successful', token, refresh_token: refreshToken });
  }

  static async refresh(req: Request, res: Response): Promise<Response> {
    const { refresh_token } = req.body as { refresh_token?: string };

    if (!refresh_token) {
      return res.status(400).json({ message: 'refresh_token is required' });
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const tokenHash = hashRefreshToken(refresh_token);

    const existing = await RefreshToken.query()
      .where('token_hash', tokenHash)
      .where('subject_type', 'platform')
      .whereNull('revoked_at')
      .where('expires_at', '>', nowIso)
      .first();

    if (!existing) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    let statusCode = 401;
    let body: Record<string, unknown> = { message: 'Unauthorized' };

    await Model.transaction(async (trx) => {
      const locked = await RefreshToken.query(trx).where('id', existing.id).forUpdate().first();

      if (!locked || locked.revoked_at || locked.expires_at <= nowIso) {
        statusCode = 401;
        body = { message: 'Unauthorized' };
        return;
      }

      const admin = await SuperAdmin.query(trx).findById(locked.subject_id);

      if (!admin) {
        statusCode = 401;
        body = { message: 'Unauthorized' };
        return;
      }

      const newRefreshToken = generateRefreshToken();

      const newRefreshRow = await RefreshToken.query(trx).insertAndFetch({
        token_hash: hashRefreshToken(newRefreshToken),
        subject_type: 'platform',
        subject_id: admin.id,
        org_id: null,
        role: 'super_admin',
        expires_at: getRefreshTokenExpiresAtIso(),
      });

      await RefreshToken.query(trx)
        .patch({
          revoked_at: nowIso,
          replaced_by: newRefreshRow.id,
        })
        .where('id', locked.id);

      const token = generateToken({
        id: admin.id,
        email: admin.email,
        role: 'super_admin',
        type: 'platform',
      });

      statusCode = 200;
      body = { token, refresh_token: newRefreshToken, message: 'Refresh successful' };
    });

    return res.status(statusCode).json(body);
  }
}

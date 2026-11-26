import type { Request, Response } from 'express';
import { z } from 'zod';

import { EmployeeExitError, EmployeeExitService } from '../../services/employee-exit.service';
import {
  immediateEmployeeExitSchema,
  initiateEmployeeExitSchema,
  updateEmployeeExitSchema,
} from '../../validators/tenant/employee-exit.validator';

const userIdParamSchema = z.object({
  userId: z.string().uuid(),
});

export class EmployeeExitController {
  private static handleError(res: Response, err: unknown): Response {
    if (err instanceof EmployeeExitError) {
      return res.status(err.statusCode).json({ message: err.message });
    }
    throw err;
  }

  static async preview(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsedParams = userIdParamSchema.safeParse(req.params);
    if (!parsedParams.success) {
      return res.status(400).json({ message: 'Invalid user id' });
    }

    try {
      const data = await EmployeeExitService.previewExit(req.user.org_id, parsedParams.data.userId);
      return res.json(data);
    } catch (err) {
      return EmployeeExitController.handleError(res, err);
    }
  }

  static async getCurrent(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsedParams = userIdParamSchema.safeParse(req.params);
    if (!parsedParams.success) {
      return res.status(400).json({ message: 'Invalid user id' });
    }

    try {
      const exit = await EmployeeExitService.getCurrentExit(
        req.user.org_id,
        parsedParams.data.userId,
      );
      return res.json({ exit });
    } catch (err) {
      return EmployeeExitController.handleError(res, err);
    }
  }

  static async initiate(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsedParams = userIdParamSchema.safeParse(req.params);
    if (!parsedParams.success) {
      return res.status(400).json({ message: 'Invalid user id' });
    }

    const parsedBody = initiateEmployeeExitSchema.safeParse(req.body);
    if (!parsedBody.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsedBody.error.flatten().fieldErrors,
      });
    }

    try {
      const exit = await EmployeeExitService.initiateExit(
        req.user.org_id,
        parsedParams.data.userId,
        req.user.id,
        parsedBody.data,
      );
      return res.status(201).json({ exit });
    } catch (err) {
      return EmployeeExitController.handleError(res, err);
    }
  }

  static async update(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsedParams = userIdParamSchema.safeParse(req.params);
    if (!parsedParams.success) {
      return res.status(400).json({ message: 'Invalid user id' });
    }

    const parsedBody = updateEmployeeExitSchema.safeParse(req.body);
    if (!parsedBody.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsedBody.error.flatten().fieldErrors,
      });
    }

    try {
      const exit = await EmployeeExitService.updateExit(
        req.user.org_id,
        parsedParams.data.userId,
        parsedBody.data,
      );
      return res.json({ exit });
    } catch (err) {
      return EmployeeExitController.handleError(res, err);
    }
  }

  static async confirm(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsedParams = userIdParamSchema.safeParse(req.params);
    if (!parsedParams.success) {
      return res.status(400).json({ message: 'Invalid user id' });
    }

    try {
      const exit = await EmployeeExitService.confirmExit(
        req.user.org_id,
        parsedParams.data.userId,
        req.user.id,
      );
      return res.json({ exit });
    } catch (err) {
      return EmployeeExitController.handleError(res, err);
    }
  }

  static async immediate(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsedParams = userIdParamSchema.safeParse(req.params);
    if (!parsedParams.success) {
      return res.status(400).json({ message: 'Invalid user id' });
    }

    const parsedBody = immediateEmployeeExitSchema.safeParse(req.body);
    if (!parsedBody.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsedBody.error.flatten().fieldErrors,
      });
    }

    try {
      const exit = await EmployeeExitService.immediateExit(
        req.user.org_id,
        parsedParams.data.userId,
        req.user.id,
        parsedBody.data,
      );
      return res.json({ exit });
    } catch (err) {
      return EmployeeExitController.handleError(res, err);
    }
  }

  static async cancel(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsedParams = userIdParamSchema.safeParse(req.params);
    if (!parsedParams.success) {
      return res.status(400).json({ message: 'Invalid user id' });
    }

    try {
      const exit = await EmployeeExitService.cancelExit(
        req.user.org_id,
        parsedParams.data.userId,
        req.user.id,
      );
      return res.json({ exit });
    } catch (err) {
      return EmployeeExitController.handleError(res, err);
    }
  }
}

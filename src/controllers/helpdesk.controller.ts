import type { Request, Response } from 'express';

import { HelpdeskTicket } from '../models/HelpdeskTicket';
import { HelpdeskTicketComment } from '../models/HelpdeskTicketComment';
import { User } from '../models/User';
import { getManagedDepartmentIds } from '../utils/department-manager.utils';

/** Strip null link IDs from ticket so they are omitted in API responses. */
function sanitizeTicketForResponse(ticket: object): Record<string, unknown> {
  const o = (ticket as { toJSON?: () => object }).toJSON
    ? (ticket as { toJSON: () => object }).toJSON()
    : ticket;
  const out = { ...(o as Record<string, unknown>) };
  if (out.leave_request_id == null) delete out.leave_request_id;
  if (out.attendance_correction_request_id == null) delete out.attendance_correction_request_id;
  return out;
}
import {
  helpdeskTicketAssignSchema,
  helpdeskTicketCommentCreateSchema,
  helpdeskTicketCreateSchema,
  helpdeskTicketIdParamsSchema,
  helpdeskTicketListQuerySchema,
  helpdeskTicketStatusSchema,
} from '../validators';

export class HelpdeskController {
  static async createTicket(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = helpdeskTicketCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { category, subject, description, priority } = parsed.data;
    const org_id = req.user.org_id;

    const attachment = (req as any).helpdeskAttachment as { url: string; key: string } | undefined;

    const ticket = await HelpdeskTicket.query().insertAndFetch({
      org_id,
      created_by: req.user.id,
      category,
      subject,
      description,
      priority,
      status: 'OPEN',
      attachment_file_key: attachment?.key ?? null,
      attachment_file_url: attachment?.url ?? null,
    });

    return res.status(201).json({
      message: 'Ticket created successfully',
      ticket: sanitizeTicketForResponse(ticket),
    });
  }

  static async listTickets(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Only admin/hr/manager can access org/team tickets.
    if (req.user.role !== 'admin' && req.user.role !== 'hr' && req.user.role !== 'manager') {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const parsed = helpdeskTicketListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { page, limit, category, status, priority, created_by, assigned_to, search } =
      parsed.data;
    const org_id = req.user.org_id;
    const isElevated = true;

    const baseQuery = HelpdeskTicket.query()
      .alias('t')
      .where('t.org_id', org_id)
      // Org/team listing should not include requester’s own tickets.
      .whereNot('t.created_by', req.user.id);

    if (req.user.role === 'manager') {
      const managedDeptIds = await getManagedDepartmentIds(org_id, req.user.id);

      // Managers can only view tickets created by their team members (users in managed departments),
      // excluding their own tickets.
      baseQuery.andWhere((qb) => {
        if (managedDeptIds.length === 0) {
          qb.whereRaw('1=0');
          return;
        }

        qb.whereIn(
          't.created_by',
          User.query()
            .select('id')
            .where('org_id', org_id)
            .whereNull('deleted_at')
            .whereIn('department_id', managedDeptIds),
        );
      });
    }

    if (isElevated && created_by) {
      baseQuery.andWhere('t.created_by', created_by);
    }

    if (assigned_to) {
      baseQuery.andWhere('t.assigned_to', assigned_to);
    }

    if (category) {
      baseQuery.andWhere('t.category', category);
    }
    if (status) {
      baseQuery.andWhere('t.status', status);
    }
    if (priority) {
      baseQuery.andWhere('t.priority', priority);
    }
    if (search) {
      const term = `%${search}%`;
      baseQuery.andWhere((qb) => {
        qb.whereILike('t.subject', term).orWhereILike('t.description', term);
      });
    }

    const totalRow = await baseQuery.clone().count('* as count').first();
    const total = Number((totalRow as any)?.count ?? 0);
    const safePage = Math.max(1, page ?? 1);
    const offset = (safePage - 1) * (limit ?? 10);

    const rows = await baseQuery
      .clone()
      .orderBy('t.created_at', 'desc')
      .withGraphFetched('[creator(selectSafe), assignee(selectSafe)]')
      .modifiers({
        selectSafe(builder) {
          builder.select(
            'id',
            'first_name',
            'last_name',
            'official_email',
            'role',
            'profile_image_url',
          );
        },
      })
      .offset(offset)
      .limit(limit ?? 10);

    const items = rows.map((t) => sanitizeTicketForResponse(t));

    return res.json({
      message: 'Tickets fetched successfully',
      page: safePage,
      limit,
      total,
      total_pages: Math.max(1, Math.ceil(total / (limit ?? 10))),
      items,
    });
  }

  static async listMyTickets(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = helpdeskTicketListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { page, limit, category, status, priority, assigned_to, search } = parsed.data;
    const org_id = req.user.org_id;

    const baseQuery = HelpdeskTicket.query()
      .alias('t')
      .where('t.org_id', org_id)
      .where('t.created_by', req.user.id);

    // Allow filtering within "my tickets"
    if (assigned_to) {
      baseQuery.andWhere('t.assigned_to', assigned_to);
    }
    if (category) {
      baseQuery.andWhere('t.category', category);
    }
    if (status) {
      baseQuery.andWhere('t.status', status);
    }
    if (priority) {
      baseQuery.andWhere('t.priority', priority);
    }
    if (search) {
      const term = `%${search}%`;
      baseQuery.andWhere((qb) => {
        qb.whereILike('t.subject', term).orWhereILike('t.description', term);
      });
    }

    const totalRow = await baseQuery.clone().count('* as count').first();
    const total = Number((totalRow as any)?.count ?? 0);
    const safePage = Math.max(1, page ?? 1);
    const offset = (safePage - 1) * (limit ?? 10);

    const rows = await baseQuery
      .clone()
      .orderBy('t.created_at', 'desc')
      .withGraphFetched('[creator(selectSafe), assignee(selectSafe)]')
      .modifiers({
        selectSafe(builder) {
          builder.select(
            'id',
            'first_name',
            'last_name',
            'official_email',
            'role',
            'profile_image_url',
          );
        },
      })
      .offset(offset)
      .limit(limit ?? 10);

    const items = rows.map((t) => sanitizeTicketForResponse(t));

    return res.json({
      message: 'Tickets fetched successfully',
      page: safePage,
      limit,
      total,
      total_pages: Math.max(1, Math.ceil(total / (limit ?? 10))),
      items,
    });
  }

  static async getTicketById(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsedParams = helpdeskTicketIdParamsSchema.safeParse(req.params);
    if (!parsedParams.success) {
      return res.status(400).json({
        message: 'Invalid route parameters',
        errors: parsedParams.error.flatten().fieldErrors,
      });
    }

    const { ticketId } = parsedParams.data;
    const org_id = req.user.org_id;

    const ticket = await HelpdeskTicket.query()
      .where('helpdesk_tickets.org_id', org_id)
      .where('helpdesk_tickets.id', ticketId)
      .withGraphFetched(
        '[creator(selectSafe), assignee(selectSafe), comments(selectSafeComment).user(selectSafeUser)]',
      )
      .modifiers({
        selectSafe(builder) {
          builder.select(
            'id',
            'first_name',
            'last_name',
            'official_email',
            'role',
            'profile_image_url',
          );
        },
        selectSafeComment(builder) {
          builder.select(
            'id',
            'ticket_id',
            'org_id',
            'user_id',
            'message',
            'file_key',
            'file_url',
            'created_at',
          );
        },
        selectSafeUser(builder) {
          builder.select(
            'id',
            'first_name',
            'last_name',
            'official_email',
            'role',
            'profile_image_url',
          );
        },
      })
      .first();

    if (!ticket) {
      return res.status(404).json({ message: 'Ticket not found' });
    }

    const isElevated =
      req.user.role === 'admin' || req.user.role === 'hr' || req.user.role === 'manager';
    if (!isElevated && ticket.created_by !== req.user.id && ticket.assigned_to !== req.user.id) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const ticketPayload = sanitizeTicketForResponse(ticket);
    const creatorId = String((ticket as any).created_by ?? '');
    if (creatorId && Array.isArray((ticketPayload as any).comments)) {
      (ticketPayload as any).comments = (ticketPayload as any).comments.map((c: any) => ({
        ...c,
        is_self: String(c?.user_id ?? '') === creatorId,
      }));
    }

    return res.json({
      message: 'Ticket fetched successfully',
      ticket: ticketPayload,
    });
  }

  static async addComment(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsedParams = helpdeskTicketIdParamsSchema.safeParse(req.params);
    if (!parsedParams.success) {
      return res.status(400).json({
        message: 'Invalid route parameters',
        errors: parsedParams.error.flatten().fieldErrors,
      });
    }
    const parsedBody = helpdeskTicketCommentCreateSchema.safeParse(req.body);
    if (!parsedBody.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsedBody.error.flatten().fieldErrors,
      });
    }

    const { ticketId } = parsedParams.data;
    const { message, attachment_file_key, attachment_file_url } = parsedBody.data;
    const org_id = req.user.org_id;

    const ticket = await HelpdeskTicket.query()
      .where('org_id', org_id)
      .where('id', ticketId)
      .first();
    if (!ticket) {
      return res.status(404).json({ message: 'Ticket not found' });
    }

    const isElevated =
      req.user.role === 'admin' || req.user.role === 'hr' || req.user.role === 'manager';
    if (!isElevated && ticket.created_by !== req.user.id && ticket.assigned_to !== req.user.id) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const comment = await HelpdeskTicketComment.query().insertAndFetch({
      ticket_id: ticket.id,
      org_id,
      user_id: req.user.id,
      message,
      file_key: attachment_file_key,
      file_url: attachment_file_url,
    });

    // Only move ticket into IN_PROGRESS when someone OTHER than the creator comments.
    // Apply the same logic for OPEN → IN_PROGRESS and REOPENED → IN_PROGRESS.
    const isCreator = ticket.created_by === req.user.id;
    if (!isCreator && (ticket.status === 'OPEN' || ticket.status === 'REOPENED')) {
      await HelpdeskTicket.query()
        .where('id', ticket.id)
        .patch({ status: 'IN_PROGRESS' as const, updated_at: new Date() });
    }

    return res.status(201).json({
      message: 'Comment added successfully',
      comment,
    });
  }

  static async updateTicketStatus(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsedParams = helpdeskTicketIdParamsSchema.safeParse(req.params);
    if (!parsedParams.success) {
      return res.status(400).json({
        message: 'Invalid route parameters',
        errors: parsedParams.error.flatten().fieldErrors,
      });
    }
    const parsedBody = helpdeskTicketStatusSchema.safeParse(req.body);
    if (!parsedBody.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsedBody.error.flatten().fieldErrors,
      });
    }

    const { ticketId } = parsedParams.data;
    const { status, approver_comment } = parsedBody.data;
    const org_id = req.user.org_id;

    const ticket = await HelpdeskTicket.query()
      .where('org_id', org_id)
      .where('id', ticketId)
      .first();
    if (!ticket) {
      return res.status(404).json({ message: 'Ticket not found' });
    }

    const isElevated =
      req.user.role === 'admin' || req.user.role === 'hr' || req.user.role === 'manager';
    if (!isElevated && ticket.created_by !== req.user.id && ticket.assigned_to !== req.user.id) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    await HelpdeskTicket.query().where('id', ticket.id).patch({
      status,
      updated_at: new Date(),
    });

    if (approver_comment && approver_comment.trim().length > 0) {
      await HelpdeskTicketComment.query().insert({
        ticket_id: ticket.id,
        org_id,
        user_id: req.user.id,
        message: approver_comment.trim(),
      });
    }

    const updated = await HelpdeskTicket.query().findById(ticket.id);

    return res.json({
      message: 'Ticket status updated successfully',
      ticket: updated ? sanitizeTicketForResponse(updated) : undefined,
    });
  }

  static async assignTicket(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    if (req.user.role !== 'admin' && req.user.role !== 'hr' && req.user.role !== 'manager') {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const parsedParams = helpdeskTicketIdParamsSchema.safeParse(req.params);
    if (!parsedParams.success) {
      return res.status(400).json({
        message: 'Invalid route parameters',
        errors: parsedParams.error.flatten().fieldErrors,
      });
    }
    const parsedBody = helpdeskTicketAssignSchema.safeParse(req.body);
    if (!parsedBody.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsedBody.error.flatten().fieldErrors,
      });
    }

    const { ticketId } = parsedParams.data;
    const { assigned_to } = parsedBody.data;
    const org_id = req.user.org_id;

    if (assigned_to) {
      const user = await User.query()
        .where('org_id', org_id)
        .where('id', assigned_to)
        .whereNull('deleted_at')
        .first();
      if (!user) {
        return res.status(400).json({ message: 'Assigned user not found in this organization' });
      }
    }

    const ticket = await HelpdeskTicket.query()
      .where('org_id', org_id)
      .where('id', ticketId)
      .first();
    if (!ticket) {
      return res.status(404).json({ message: 'Ticket not found' });
    }

    await HelpdeskTicket.query()
      .where('id', ticket.id)
      .patch({ assigned_to: assigned_to ?? null, updated_at: new Date() });

    const updated = await HelpdeskTicket.query().findById(ticket.id);

    return res.json({
      message: 'Ticket assignment updated successfully',
      ticket: updated,
    });
  }
}

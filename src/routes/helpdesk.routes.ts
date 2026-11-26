import { Router } from 'express';

import { HelpdeskController } from '../controllers/helpdesk.controller';
import { authenticateTenant } from '../middlewares';
import { helpdeskAttachmentUploader } from '../utils/s3Uploader';

const helpdeskRoutes = Router();

helpdeskRoutes.use(authenticateTenant);

helpdeskRoutes.post('/tickets', helpdeskAttachmentUploader, HelpdeskController.createTicket);
helpdeskRoutes.get('/tickets', HelpdeskController.listTickets);
helpdeskRoutes.get('/tickets/my', HelpdeskController.listMyTickets);
helpdeskRoutes.get('/tickets/:ticketId', HelpdeskController.getTicketById);
helpdeskRoutes.post('/tickets/:ticketId/comments', HelpdeskController.addComment);
helpdeskRoutes.patch('/tickets/:ticketId/status', HelpdeskController.updateTicketStatus);
helpdeskRoutes.patch('/tickets/:ticketId/assign', HelpdeskController.assignTicket);

export { helpdeskRoutes };

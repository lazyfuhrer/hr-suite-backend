import type { Request, Response } from 'express';
import { OrganizationDocument } from '../../models/OrganizationDocument';

interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    org_id: string;
  };
  s3Uploads?: Array<{
    doc_type: string;
    file_url: string;
    doc_category: string;
    file_key?: string;
  }>;
}

export class OrganizationDocumentController {
  static async getAll(req: AuthenticatedRequest, res: Response): Promise<Response> {
    try {
      if (!req.user?.org_id) {
        return res.status(401).json({ message: 'Unauthorized: Org context missing' });
      }

      const docs = await OrganizationDocument.query()
        .where('org_id', req.user.org_id)
        .orderBy('created_at', 'desc');

      return res.status(200).json(docs);
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to fetch documents',
      });
    }
  }

  static async create(req: AuthenticatedRequest, res: Response): Promise<Response> {
    try {
      const uploads = req.s3Uploads;
      const orgId = req.user?.org_id;

      if (!orgId) return res.status(401).json({ message: 'Unauthorized' });
      if (!uploads || uploads.length === 0) {
        return res.status(400).json({ message: 'No file uploaded' });
      }

      const docsToInsert = uploads.map((doc) => ({
        ...doc,
        org_id: orgId,
        doc_category: req.body.doc_category || doc.doc_category,
      }));

      const newDocs = await OrganizationDocument.query().insert(docsToInsert);
      return res.status(201).json(newDocs);
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to create document',
      });
    }
  }

  static async update(req: AuthenticatedRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const orgId = req.user?.org_id;

      if (!orgId) return res.status(401).json({ message: 'Unauthorized' });

      // 1. Create a clean object with ONLY the allowed columns
      const updateData: any = {};

      // Explicitly check for valid fields in req.body
      if (req.body.doc_category) updateData.doc_category = req.body.doc_category;
      if (req.body.doc_type) updateData.doc_type = req.body.doc_type;
      if (req.body.verification_status)
        updateData.verification_status = req.body.verification_status;

      // 2. If a file was uploaded, add the S3 details
      if (req.s3Uploads && req.s3Uploads.length > 0) {
        const fileData = req.s3Uploads[0];
        updateData.file_url = fileData.file_url;
        updateData.file_key = fileData.file_key;
        updateData.doc_type = fileData.doc_type; // Use the new file's type
        updateData.verification_status = 'PENDING'; // Reset status on new file
      }

      // 3. Prevent empty updates
      if (Object.keys(updateData).length === 0) {
        return res.status(400).json({ message: 'No valid fields provided for update' });
      }

      const updated = await OrganizationDocument.query()
        .patchAndFetchById(id, updateData)
        .where('org_id', orgId);

      if (!updated) return res.status(404).json({ message: 'Document not found' });

      return res.status(200).json(updated);
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Update failed',
      });
    }
  }

  static async remove(req: AuthenticatedRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const orgId = req.user?.org_id;

      if (!orgId) return res.status(401).json({ message: 'Unauthorized' });

      const deletedCount = await OrganizationDocument.query().deleteById(id).where('org_id', orgId);

      if (deletedCount === 0) {
        return res.status(404).json({ message: 'Document not found' });
      }

      return res.status(204).send();
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Deletion failed',
      });
    }
  }
}

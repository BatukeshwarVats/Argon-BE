/**
 * Thin HTTP layer for the Image resource.
 *
 * - Parses inputs with zod.
 * - Delegates to ImageService.
 * - Translates rows → views before sending (presigned URLs, ISO timestamps).
 */
import type { Request, Response, NextFunction } from 'express';
import { ImageService } from '../../domain/services/image.service';
import { eventBus } from '../../shared/events';
import { ValidationError } from '../../shared/errors';
import {
  listImagesQuerySchema,
  imageIdParamSchema,
} from '../validators/images.schemas';

export class ImagesController {
  constructor(private readonly service: ImageService) {}

  // POST /api/images  (multipart, field: "images" — repeats for batch)
  upload = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (files.length === 0) {
        throw new ValidationError('No files uploaded. Use multipart field "images".');
      }

      // Upload each file; collect successes and per-file errors separately so
      // a single bad file doesn't blow up the whole batch.
      const results = await Promise.allSettled(
        files.map((f) =>
          this.service.upload({
            userId: req.userId,
            originalName: f.originalname,
            buffer: f.buffer,
            declaredMime: f.mimetype,
          }),
        ),
      );

      const accepted = [];
      const rejected = [];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === 'fulfilled') {
          accepted.push(await this.service.toView(r.value));
        } else {
          const err = r.reason;
          rejected.push({
            originalName: files[i].originalname,
            error: {
              code: err.code ?? 'INTERNAL_ERROR',
              message: err.message ?? 'Upload failed',
            },
          });
        }
      }

      res.status(202).json({ accepted, rejected });
    } catch (err) {
      next(err);
    }
  };

  // GET /api/images
  list = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = listImagesQuerySchema.parse(req.query);
      const rows = await this.service.list({
        userId: req.userId,
        status: query.status,
        limit: query.limit,
        cursor: query.cursor,
      });
      const items = await this.service.toViews(rows);
      res.json({
        items,
        nextCursor: items.length === query.limit ? items[items.length - 1].id : null,
      });
    } catch (err) {
      next(err);
    }
  };

  // GET /api/images/:id
  getOne = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = imageIdParamSchema.parse(req.params);
      const row = await this.service.getById(id);
      res.json(await this.service.toView(row));
    } catch (err) {
      next(err);
    }
  };

  // GET /api/images/:id/variants  — the generated thumbnail/web/full sizes
  variants = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = imageIdParamSchema.parse(req.params);
      const variants = await this.service.getVariants(id);
      res.json({ imageId: id, variants });
    } catch (err) {
      next(err);
    }
  };

  // POST /api/images/:id/reprocess  — re-run the media pipeline (idempotent)
  reprocess = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = imageIdParamSchema.parse(req.params);
      const row = await this.service.reprocess(id);
      res.status(202).json(await this.service.toView(row));
    } catch (err) {
      next(err);
    }
  };

  // POST /api/images/seed  — load-test entry: inject directly into the pipeline
  // (multipart field "images"). Skips validation; non-production only.
  seed = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (files.length === 0) {
        throw new ValidationError('No files uploaded. Use multipart field "images".');
      }
      const results = await Promise.allSettled(
        files.map((f) =>
          this.service.seedForPipeline({
            userId: req.userId,
            originalName: f.originalname,
            buffer: f.buffer,
            declaredMime: f.mimetype,
          }),
        ),
      );
      const accepted: Array<{ id: string; status: string }> = [];
      const rejected: Array<{ originalName: string; error: { code: string; message: string } }> = [];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === 'fulfilled') {
          accepted.push({ id: r.value.id, status: r.value.status });
        } else {
          rejected.push({
            originalName: files[i].originalname,
            error: {
              code: r.reason?.code ?? 'INTERNAL_ERROR',
              message: r.reason?.message ?? 'Seed failed',
            },
          });
        }
      }
      res.status(202).json({ accepted, rejected });
    } catch (err) {
      next(err);
    }
  };

  // DELETE /api/images/:id
  remove = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = imageIdParamSchema.parse(req.params);
      await this.service.remove(id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  };

  // GET /api/images/events  (SSE)
  //
  // Streams every status change for the requesting user. Frontend opens one
  // connection on app boot and re-renders cards as messages arrive.
  events = (req: Request, res: Response) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    // Send a comment immediately so proxies don't buffer waiting for first byte.
    res.write(': connected\n\n');

    const unsubscribe = eventBus.onStatus((ev) => {
      if (ev.userId !== req.userId) return;
      res.write(`event: image.status\ndata: ${JSON.stringify(ev)}\n\n`);
    });

    // Heartbeat every 25s so corporate proxies don't kill idle connections.
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  };
}

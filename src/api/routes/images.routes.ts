import { Router } from 'express';
import { upload, uploadBatch } from '../middleware/upload.middleware';
import { ImagesController } from '../controllers/images.controller';
import type { Container } from '../../shared/container';

export function buildImagesRouter(container: Container): Router {
  const router = Router();
  const controller = new ImagesController(container.imageService);

  router.post('/', upload.array('images', 10), controller.upload);
  router.post('/seed', uploadBatch.array('images', 200), controller.seed); // load-test entry
  router.get('/events', controller.events);     // SSE
  router.get('/', controller.list);
  router.get('/:id/variants', controller.variants);
  router.post('/:id/reprocess', controller.reprocess);
  router.get('/:id', controller.getOne);
  router.delete('/:id', controller.remove);

  return router;
}

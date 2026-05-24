/**
 * Tiny manual DI container.
 *
 * - One place that wires concrete adapters into services.
 * - Both the API entrypoint and the worker entrypoint import from here,
 *   so swapping a dependency (e.g. mock storage in tests) is one line.
 */
import { ImageService } from '../domain/services/image.service';
import { imageRepository } from '../infra/repositories/image.repository';
import { S3StorageAdapter } from '../infra/storage/s3.storage';
import type { IStorageAdapter } from '../infra/storage/storage.interface';

export interface Container {
  storage: IStorageAdapter;
  imageService: ImageService;
}

let cached: Container | null = null;

export function buildContainer(): Container {
  if (cached) return cached;
  const storage = new S3StorageAdapter();
  const imageService = new ImageService(imageRepository, storage);
  cached = { storage, imageService };
  return cached;
}

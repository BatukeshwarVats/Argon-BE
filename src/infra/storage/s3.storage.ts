/**
 * S3-backed `IStorageAdapter`.
 *
 * Works against:
 *   - MinIO (local): set AWS_S3_ENDPOINT + AWS_S3_FORCE_PATH_STYLE=true
 *   - AWS S3 (prod): leave AWS_S3_ENDPOINT empty
 *
 * The SDK call surface is identical; only the client config differs.
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';
import { config } from '../../config';
import { logger } from '../../shared/logger';
import type { IStorageAdapter, PutObjectInput } from './storage.interface';

export class S3StorageAdapter implements IStorageAdapter {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    this.bucket = config.AWS_S3_BUCKET;
    this.client = new S3Client({
      region: config.AWS_REGION,
      endpoint: config.AWS_S3_ENDPOINT || undefined,
      forcePathStyle: config.AWS_S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: config.AWS_ACCESS_KEY_ID,
        secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
      },
    });
  }

  async putObject({ key, body, contentType, cacheControl }: PutObjectInput): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: cacheControl,
      }),
    );
    logger.debug({ key, bytes: body.length }, 's3.put');
  }

  async getObject(key: string): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const stream = res.Body as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    logger.debug({ key }, 's3.delete');
  }

  async getSignedUrl(key: string, ttlSeconds: number): Promise<string> {
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, cmd, { expiresIn: ttlSeconds });
  }
}

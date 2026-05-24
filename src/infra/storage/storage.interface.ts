/**
 * Storage adapter abstraction.
 *
 * - The Image service knows about `IStorageAdapter`, not S3.
 * - This lets us swap MinIO ↔ AWS S3 ↔ local filesystem with one env change,
 *   and stub storage in unit tests without touching network code.
 */

export interface PutObjectInput {
  key: string;
  body: Buffer;
  contentType: string;
  /**
   * Optional cache-control header. Useful when we serve the converted display
   * image via a public CDN later.
   */
  cacheControl?: string;
}

export interface IStorageAdapter {
  putObject(input: PutObjectInput): Promise<void>;
  getObject(key: string): Promise<Buffer>;
  deleteObject(key: string): Promise<void>;
  /**
   * Generate a presigned URL for direct GET. The frontend uses these for previews.
   */
  getSignedUrl(key: string, ttlSeconds: number): Promise<string>;
}

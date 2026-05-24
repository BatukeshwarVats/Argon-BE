/**
 * Bootstrap the MinIO bucket on first run.
 * Idempotent — safe to re-run.
 */
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import * as dotenv from 'dotenv';

dotenv.config();

async function main() {
  const bucket = process.env.AWS_S3_BUCKET ?? 'argon-images';
  const endpoint = process.env.AWS_S3_ENDPOINT ?? 'http://localhost:9000';

  const s3 = new S3Client({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint,
    forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === 'true',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'argonadmin',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'argonadmin',
    },
  });

  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    console.log(`[setup-minio] bucket "${bucket}" already exists.`);
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`[setup-minio] bucket "${bucket}" created.`);
  }
}

main().catch((err) => {
  console.error('[setup-minio] failed:', err);
  process.exit(1);
});

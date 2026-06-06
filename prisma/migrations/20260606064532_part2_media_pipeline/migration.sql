-- CreateEnum
CREATE TYPE "VariantType" AS ENUM ('THUMBNAIL', 'WEB', 'FULL');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ImageStatus" ADD VALUE 'PROCESSING_CONVERT';
ALTER TYPE "ImageStatus" ADD VALUE 'PROCESSING_COMPRESS';
ALTER TYPE "ImageStatus" ADD VALUE 'PROCESSING_VARIANTS';
ALTER TYPE "ImageStatus" ADD VALUE 'COMPLETED';

-- AlterTable
ALTER TABLE "images" ADD COLUMN     "compressedBytes" INTEGER,
ADD COLUMN     "compressedKey" TEXT,
ADD COLUMN     "compressionRatio" DOUBLE PRECISION,
ADD COLUMN     "normalizedKey" TEXT,
ADD COLUMN     "processingError" TEXT;

-- CreateTable
CREATE TABLE "variants" (
    "id" TEXT NOT NULL,
    "imageId" TEXT NOT NULL,
    "type" "VariantType" NOT NULL,
    "s3Key" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "variants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "variants_imageId_idx" ON "variants"("imageId");

-- CreateIndex
CREATE UNIQUE INDEX "variants_imageId_type_key" ON "variants"("imageId", "type");

-- AddForeignKey
ALTER TABLE "variants" ADD CONSTRAINT "variants_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "images"("id") ON DELETE CASCADE ON UPDATE CASCADE;

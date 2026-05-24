-- CreateEnum
CREATE TYPE "ImageStatus" AS ENUM ('PENDING', 'PROCESSING', 'ACCEPTED', 'REJECTED', 'FAILED');

-- CreateTable
CREATE TABLE "images" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "s3KeyOriginal" TEXT NOT NULL,
    "s3KeyDisplay" TEXT,
    "perceptualHash" TEXT,
    "status" "ImageStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReasons" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "images_userId_status_createdAt_idx" ON "images"("userId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "images_userId_perceptualHash_idx" ON "images"("userId", "perceptualHash");

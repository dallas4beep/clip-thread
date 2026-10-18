import "server-only";
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type Part,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { serverEnv } from "@/lib/env";

let client: S3Client | undefined;

export function r2(): S3Client {
  if (client) return client;
  const env = serverEnv();
  client = new S3Client({
    region: "auto",
    endpoint: env.R2_ENDPOINT ?? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    forcePathStyle: Boolean(env.R2_ENDPOINT),
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
    // Newer SDKs add CRC32 checksum params to every request by default; presigned
    // part URLs would then require the browser to send a matching checksum.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return client;
}

const bucket = () => serverEnv().R2_BUCKET;

export async function createMultipartUpload(key: string, contentType: string): Promise<string> {
  const out = await r2().send(
    new CreateMultipartUploadCommand({ Bucket: bucket(), Key: key, ContentType: contentType }),
  );
  if (!out.UploadId) throw new Error("R2 did not return an UploadId");
  return out.UploadId;
}

export async function presignUploadPart(key: string, uploadId: string, partNumber: number, expiresIn = 3600) {
  return getSignedUrl(
    r2(),
    new UploadPartCommand({ Bucket: bucket(), Key: key, UploadId: uploadId, PartNumber: partNumber }),
    { expiresIn },
  );
}

/** Returns already-uploaded parts, or null if the upload no longer exists (expired/aborted). */
export async function listUploadedParts(key: string, uploadId: string): Promise<Part[] | null> {
  const parts: Part[] = [];
  let marker: string | undefined;
  try {
    do {
      const out = await r2().send(
        new ListPartsCommand({ Bucket: bucket(), Key: key, UploadId: uploadId, PartNumberMarker: marker }),
      );
      parts.push(...(out.Parts ?? []));
      marker = out.IsTruncated ? out.NextPartNumberMarker : undefined;
    } while (marker);
  } catch (err) {
    if ((err as { name?: string }).name === "NoSuchUpload") return null;
    throw err;
  }
  return parts;
}

export async function completeMultipartUpload(
  key: string,
  uploadId: string,
  parts: { partNumber: number; etag: string }[],
) {
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  await r2().send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket(),
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: sorted.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
    }),
  );
}

export async function headObject(key: string): Promise<{ size: number } | null> {
  try {
    const out = await r2().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return { size: out.ContentLength ?? 0 };
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e.name === "NotFound" || e.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

export async function putJson(key: string, body: unknown) {
  await r2().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: JSON.stringify(body),
      ContentType: "application/json",
    }),
  );
}

/** Short-lived read URL. Media stays in a private bucket; only approved keys are ever signed for the public API. */
export async function presignGet(key: string, expiresIn = 3600) {
  return getSignedUrl(r2(), new GetObjectCommand({ Bucket: bucket(), Key: key }), { expiresIn });
}

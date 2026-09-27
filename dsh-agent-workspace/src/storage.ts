import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
export interface BlobStore {
  put(key: string, content: Uint8Array): Promise<void>;
  get(key: string, expectedBytes: number): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  ready(): Promise<void>;
}
export function s3Store(config: {
  endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string;
}): BlobStore & { close(): void } {
  const client = new S3Client({
    endpoint: config.endpoint, region: config.region, forcePathStyle: true, maxAttempts: 1,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  const options = () => ({ abortSignal: AbortSignal.timeout(5000) });
  return {
    async put(key, content) {
      await client.send(new PutObjectCommand({
        Bucket: config.bucket, Key: key, Body: content, ContentLength: content.byteLength,
        ContentType: "text/plain; charset=utf-8", IfNoneMatch: "*",
      }), options());
    },
    async get(key, expectedBytes) {
      const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }), options());
      const body = response.Body;
      if (!body) throw new Error("Missing object body");
      const stream = body as AsyncIterable<Uint8Array> & { destroy?: () => void };
      try {
        if (response.ContentLength !== expectedBytes) throw new Error("Object size mismatch");
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of stream) {
          size += chunk.byteLength;
          if (size > expectedBytes) throw new Error("Object exceeds bound");
          chunks.push(chunk);
        }
        if (size !== expectedBytes) throw new Error("Incomplete object");
        return Buffer.concat(chunks, size);
      } finally { stream.destroy?.(); }
    },
    async delete(key) { await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }), options()); },
    async ready() { await client.send(new HeadBucketCommand({ Bucket: config.bucket }), options()); },
    close() { client.destroy(); },
  };
}

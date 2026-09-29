#!/usr/bin/env node
/**
 * Create the S3 bucket the API expects, if it isn't already there.
 *
 * The e2e workflow used to get its bucket from `minio/mc`, which went away with
 * the rest of MinIO's public images (oss-520). Its replacement, adobe/s3mock,
 * advertises an `initialBuckets` setting — but on 5.2.3 that env var is ignored
 * (verified across `initialBuckets`, `INITIALBUCKETS`, `INITIAL_BUCKETS` and the
 * fully-qualified property name: `ListBuckets` comes back empty every time), so
 * the bucket has to be created explicitly.
 *
 * s3mock does auto-create a bucket on first PutObject, which makes it tempting
 * to skip this. Don't: a presigned PUT against a missing bucket 404s, and that
 * is the path the dashboard's upload flow actually takes.
 *
 * Uses the same AWS SDK and env vars as the API itself, so what passes here is
 * what the API will see. Idempotent — an existing bucket is a no-op.
 *
 *   node api/scripts/s3-ensure-bucket.mjs        # from the repo root
 */

import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const endpoint = process.env.KOJI_S3_ENDPOINT;
const bucket = process.env.KOJI_S3_BUCKET;

if (!endpoint || !bucket) {
  console.error("s3-ensure-bucket: KOJI_S3_ENDPOINT and KOJI_S3_BUCKET are required");
  process.exit(1);
}

const client = new S3Client({
  endpoint,
  region: process.env.KOJI_S3_REGION ?? "us-east-1",
  forcePathStyle: (process.env.KOJI_S3_FORCE_PATH_STYLE ?? "true") !== "false",
  credentials: {
    accessKeyId: process.env.KOJI_S3_ACCESS_KEY ?? "koji",
    secretAccessKey: process.env.KOJI_S3_SECRET_KEY ?? "kojisecret",
  },
});

/**
 * A container that has just started answering HTTP can still drop the first
 * connection while the app finishes coming up, which shows as ECONNRESET. The
 * caller's readiness probe only proves the port is listening, so retry briefly
 * rather than turn a cold start into a red build.
 */
async function withRetry(label, fn, attempts = 10) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const transient =
        err?.code === "ECONNRESET" ||
        err?.code === "ECONNREFUSED" ||
        err?.name === "TimeoutError";
      if (!transient || attempt >= attempts) throw err;
      console.log(`s3-ensure-bucket: ${label} not ready (${err.code ?? err.name}), retrying ${attempt}/${attempts}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

const exists = await withRetry("endpoint", async () => {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch (err) {
    // HeadBucket answers NotFound / NoSuchBucket / 403 depending on the
    // implementation. Only a genuinely transient failure should be retried, so
    // rethrow those and treat anything else as "the bucket isn't there".
    if (err?.code === "ECONNRESET" || err?.code === "ECONNREFUSED" || err?.name === "TimeoutError") {
      throw err;
    }
    return false;
  }
});

if (exists) {
  console.log(`s3-ensure-bucket: ${bucket} already exists at ${endpoint}`);
} else {
  await withRetry("create", () => client.send(new CreateBucketCommand({ Bucket: bucket })));
  console.log(`s3-ensure-bucket: created ${bucket} at ${endpoint}`);
}

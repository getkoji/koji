/**
 * Presigned URL upload utility.
 *
 * Uploads files directly to S3/R2 using a presigned PUT URL, bypassing
 * Vercel's 4.5 MB body size limit. Every upload surface in the dashboard
 * should use this function instead of posting FormData to the API.
 */

import { api } from "./api";

interface PresignResponse {
  uploadUrl: string;
  storageKey: string;
}

export interface UploadOptions {
  file: File;
  context: "corpus" | "test";
  schemaSlug?: string;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

export interface UploadResult<T = unknown> {
  storageKey: string;
  entry?: T;
}

/**
 * Upload a file via presigned URL.
 *
 * 1. Calls the presign endpoint to get a signed PUT URL
 * 2. PUTs the file directly to S3/R2 (with progress tracking)
 * 3. For corpus context: calls the complete endpoint to create the DB record
 * 4. For test context: returns the storageKey for the caller to pass to the test endpoint
 */
export async function uploadFile<T = unknown>(options: UploadOptions): Promise<UploadResult<T>> {
  const { file, context, schemaSlug, onProgress, signal } = options;

  // Step 1: Get presigned URL
  const { uploadUrl, storageKey } = await api.post<PresignResponse>("/api/upload/presign", {
    filename: file.name,
    contentType: file.type || "application/octet-stream",
    context,
    schemaSlug,
  });

  // Step 2: PUT file directly to S3
  await putFileToS3(uploadUrl, file, file.type || "application/octet-stream", onProgress, signal);

  // Step 3: Finalize
  if (context === "corpus") {
    const entry = await api.post<T>("/api/upload/complete", {
      storageKey,
      filename: file.name,
      context,
      schemaSlug,
    });
    return { storageKey, entry };
  }

  return { storageKey };
}

/**
 * PUT a file to S3 using XMLHttpRequest for upload progress tracking.
 * fetch() does not support upload.onprogress, so we use XHR.
 */
function putFileToS3(
  url: string,
  file: File,
  contentType: string,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);

    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Upload failed with status ${xhr.status}`));
      }
    };

    xhr.onerror = () => reject(new Error("Upload failed — network error"));
    xhr.ontimeout = () => reject(new Error("Upload timed out"));

    if (signal) {
      signal.addEventListener("abort", () => xhr.abort());
      xhr.onabort = () => reject(new DOMException("Upload aborted", "AbortError"));
    }

    xhr.send(file);
  });
}

/**
 * Mapping between the API's job status vocabulary and the UI vocabulary.
 *
 * API uses:     "complete" | "running" | "failed" | "canceled" | "pending"
 * UI uses:      "succeeded" | "running" | "failed" | "cancelled"
 *
 * Keeping the UI vocabulary in one place means the label/color logic on the
 * list and detail pages stays consistent even as the backend grows new states.
 */

export type UiJobStatus = "running" | "succeeded" | "failed" | "cancelled";

export const JOB_STATUS_ORDER: UiJobStatus[] = [
  "running",
  "succeeded",
  "failed",
  "cancelled",
];

export function normalizeJobStatus(apiStatus: string): UiJobStatus {
  switch (apiStatus) {
    case "complete":
    case "succeeded":
      return "succeeded";
    case "canceled":
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "running":
    case "pending":
    default:
      return "running";
  }
}

// Document statuses — also normalized so UI logic doesn't scatter.
export type UiDocStatus = "received" | "extracting" | "delivered" | "failed" | "review";

export function normalizeDocStatus(apiStatus: string): UiDocStatus {
  switch (apiStatus) {
    case "delivered":
    case "complete":
      return "delivered";
    case "extracting":
    case "processing":
      return "extracting";
    case "failed":
      return "failed";
    case "review":
    case "in_review":
      return "review";
    case "received":
    case "pending":
    default:
      return "received";
  }
}

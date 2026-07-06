/**
 * Client for the parse service's `/normalize-pdf` endpoint — re-save a PDF
 * that pdf-lib cannot read into one it can.
 *
 * pdf-lib chokes on a real-world document class: PDFs with the classic
 * owner-password encryption (Standard security handler, EMPTY user password —
 * the "no-print restriction" pattern carriers and law firms ship routinely)
 * whose page tree lives in compressed object streams. `ignoreEncryption: true`
 * skips decryption rather than performing it, so those object streams never
 * inflate and `PDFDocument.load` throws — taking out both `probePdf`'s primary
 * count and `slicePdfPages` (oss-377). PDFium (docker parse service) and MuPDF
 * (Modal) decrypt the empty-user-password case transparently, so a service-side
 * re-save yields a plain PDF the local pdf-lib path handles end to end.
 *
 * One round trip per document, only on the pdf-lib-unreadable path — callers
 * probe first (`probePdf`) and normalize only when `pdfLibLoadable` is false.
 *
 * Backend selection mirrors the parse factory's config (`factory.ts`): the
 * same `KOJI_PARSE_BACKEND` / `KOJI_PARSE_URL` / `KOJI_PARSE_MODAL_URL` env
 * vars, with explicit config injectable for tests and non-Node entry points.
 * Reading env here (rather than threading `ParseConfig` through the BYO driver
 * registry) matches `modal.ts`, which falls back to the same env vars.
 */

/** Where the normalize call goes — a subset of `factory.ts`'s ParseConfig. */
export interface PdfNormalizeConfig {
  backend: "docker" | "modal";
  /** Base URL of the sidecar `koji-parse` container (docker backend). */
  dockerUrl?: string;
  /** Modal `parse_http` endpoint URL (modal backend). */
  modalUrl?: string;
  /** Modal proxy-auth key id (`Modal-Key` header). */
  modalTokenId?: string;
  /** Modal proxy-auth secret (`Modal-Secret` header). */
  modalTokenSecret?: string;
}

/**
 * Resolve the normalize target from the same env vars `index.ts` wires.
 *
 * Backend inference: an explicit `KOJI_PARSE_BACKEND` wins; otherwise the
 * presence of `KOJI_PARSE_MODAL_URL` selects modal. This matters because the
 * hosted platform hardcodes `backend: "modal"` in code (it never sets
 * `KOJI_PARSE_BACKEND`) — without the inference this helper would default to
 * "docker" there and dial a sidecar that doesn't exist.
 *
 * Proxy-auth credentials: `MODAL_PROXY_KEY`/`MODAL_PROXY_SECRET` first, then
 * `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET` — the same order the platform's
 * `entry.ts` wires into ModalParseProvider. In production both pairs are set
 * but only the PROXY pair is a Modal proxy-auth token; the TOKEN pair is the
 * account API token, which Modal's proxy rejects with a 401 (oss-379).
 */
export function pdfNormalizeConfigFromEnv(): PdfNormalizeConfig {
  const explicit = process.env.KOJI_PARSE_BACKEND as "docker" | "modal" | undefined;
  const modalUrl = process.env.KOJI_PARSE_MODAL_URL;
  return {
    backend: explicit ?? (modalUrl ? "modal" : "docker"),
    dockerUrl: process.env.KOJI_PARSE_URL ?? "http://koji-parse:9410",
    modalUrl,
    modalTokenId: process.env.MODAL_PROXY_KEY ?? process.env.MODAL_TOKEN_ID,
    modalTokenSecret: process.env.MODAL_PROXY_SECRET ?? process.env.MODAL_TOKEN_SECRET,
  };
}

interface NormalizeResponse {
  pdf_base64?: string;
  pages?: number;
  byte_size?: number;
  error?: string;
}

/**
 * Re-save `fileBuffer` through the parse service and return the normalized
 * bytes. Throws with a descriptive message when the service is unreachable,
 * rejects the document, or returns an unusable payload — callers decide the
 * fallback (whole-doc parse, batch, or surfacing the error).
 */
export async function normalizePdfViaService(
  fileBuffer: Buffer,
  filename: string,
  config: PdfNormalizeConfig = pdfNormalizeConfigFromEnv(),
): Promise<Buffer> {
  let url: string;
  const headers: Record<string, string> = {};

  if (config.backend === "modal") {
    if (!config.modalUrl) {
      throw new Error(
        "normalize-pdf: KOJI_PARSE_MODAL_URL is not configured for the modal parse backend",
      );
    }
    url = config.modalUrl.replace("parse-http", "normalize-pdf");
    headers["Modal-Key"] = config.modalTokenId ?? "";
    headers["Modal-Secret"] = config.modalTokenSecret ?? "";
  } else {
    if (!config.dockerUrl) {
      throw new Error("normalize-pdf: KOJI_PARSE_URL is not configured");
    }
    url = `${config.dockerUrl.replace(/\/+$/, "")}/normalize-pdf`;
  }

  // See modal.ts — Buffer doesn't unify with DOM's BlobPart under strict
  // Workers type libs; copying into a fresh ArrayBuffer-backed Uint8Array
  // works in both typesets.
  const part = Uint8Array.from(fileBuffer);
  const form = new FormData();
  form.append("file", new Blob([part], { type: "application/pdf" }), filename);

  const resp = await fetch(url, {
    method: "POST",
    body: form,
    headers,
    redirect: "follow",
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`normalize-pdf ${resp.status}: ${body.slice(0, 300)}`);
  }

  const result = (await resp.json()) as NormalizeResponse;
  if (!result.pdf_base64) {
    throw new Error(
      `normalize-pdf: service returned no pdf_base64${result.error ? ` (${result.error})` : ""}`,
    );
  }
  return Buffer.from(result.pdf_base64, "base64");
}

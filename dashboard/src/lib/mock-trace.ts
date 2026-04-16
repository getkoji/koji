export interface TraceStage {
  name: string;
  durationMs: number;
  startPct: number;
  widthPct: number;
  status: "ok" | "warn" | "fail";
  meta: string;
}

export interface TraceField {
  name: string;
  value: string;
  chunk: string;
  confidence: number;
  wrong?: boolean;
  diagnostic?: string;
}

export const MOCK_STAGES: TraceStage[] = [
  { name: "Ingress", durationMs: 212, startPct: 0, widthPct: 1.2, status: "ok", meta: "s3://acme-invoices-inbound · 114 KB" },
  { name: "Integrity check", durationMs: 5, startPct: 1.2, widthPct: 0.6, status: "ok", meta: "valid PDF · 1 page" },
  { name: "OCR quality", durationMs: 20, startPct: 1.8, widthPct: 0.6, status: "ok", meta: "text density 0.94 · en 0.99" },
  { name: "Classify", durationMs: 85, startPct: 2.4, widthPct: 0.6, status: "ok", meta: "invoice 0.89 · receipt 0.06" },
  { name: "Extract", durationMs: 2273, startPct: 3.0, widthPct: 12.7, status: "warn", meta: "gpt-4o-mini · 4 chunks · 8 fields" },
  { name: "Normalize", durationMs: 15, startPct: 15.7, widthPct: 0.6, status: "ok", meta: "3 transforms applied" },
  { name: "Validate", durationMs: 8, startPct: 16.3, widthPct: 0.6, status: "fail", meta: "3 / 4 rules passed" },
  { name: "Review queue", durationMs: 12, startPct: 16.9, widthPct: 0.6, status: "warn", meta: "1 field flagged by validation" },
  { name: "Human review", durationMs: 14423, startPct: 17.5, widthPct: 80.8, status: "ok", meta: "accepted by frank@getkoji.dev · override applied" },
  { name: "Emit", durationMs: 203, startPct: 98.3, widthPct: 1.2, status: "ok", meta: "webhook → acme.com · 200 OK · 145ms" },
];

export const MOCK_FIELDS: TraceField[] = [
  { name: "invoice_number", value: '"2026-087"', chunk: "ch 01", confidence: 0.99 },
  { name: "invoice_date", value: '"2026-03-28"', chunk: "ch 01", confidence: 0.99 },
  { name: "vendor", value: '"Brighton & Co. Contractors"', chunk: "ch 02", confidence: 0.97 },
  { name: "bill_to", value: '"Vantage Capital"', chunk: "ch 02", confidence: 0.96 },
  { name: "line_items", value: "2 items", chunk: "ch 03", confidence: 0.94 },
  { name: "subtotal", value: "3950.00", chunk: "ch 04", confidence: 0.99 },
  { name: "tax", value: "300.00", chunk: "ch 04", confidence: 0.99 },
  {
    name: "total_amount",
    value: "500.00",
    chunk: "ch 03",
    confidence: 0.92,
    wrong: true,
    diagnostic:
      'Model picked chunk 03 (services) because the new "BALANCE DUE" alias matched "PREVIOUS BALANCE DUE" in that chunk — which is an outstanding balance from the prior billing period, not the current total. The correct value $4,250.00 is in chunk 04 (totals). This regression was caught by the subtotal_plus_tax_eq_total validation rule in stage 07 and corrected by human review in stage 09.',
  },
];

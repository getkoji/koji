export interface SchemaLine {
  num: number;
  content: string;
  added?: boolean;
}

export const MOCK_SCHEMA_LINES: SchemaLine[] = [
  { num: 1, content: '<span class="text-vermillion-2 font-medium">name</span><span class="text-ink-4">:</span> invoice' },
  { num: 2, content: '<span class="text-vermillion-2 font-medium">description</span><span class="text-ink-4">:</span> <span class="text-ink-2">Commercial invoice</span>' },
  { num: 3, content: '<span class="text-vermillion-2 font-medium">version</span><span class="text-ink-4">:</span> v12' },
  { num: 4, content: "" },
  { num: 5, content: '<span class="text-vermillion-2 font-medium">fields</span><span class="text-ink-4">:</span>' },
  { num: 6, content: '  <span class="text-vermillion-2 font-medium">invoice_number</span><span class="text-ink-4">:</span>' },
  { num: 7, content: '    <span class="text-vermillion-2 font-medium">type</span><span class="text-ink-4">:</span> <span class="text-ink-2">string</span>' },
  { num: 8, content: '    <span class="text-vermillion-2 font-medium">required</span><span class="text-ink-4">:</span> <span class="text-green">true</span>' },
  { num: 9, content: "" },
  { num: 10, content: '  <span class="text-vermillion-2 font-medium">invoice_date</span><span class="text-ink-4">:</span>' },
  { num: 11, content: '    <span class="text-vermillion-2 font-medium">type</span><span class="text-ink-4">:</span> <span class="text-ink-2">date</span>' },
  { num: 12, content: '    <span class="text-vermillion-2 font-medium">required</span><span class="text-ink-4">:</span> <span class="text-green">true</span>' },
  { num: 13, content: "" },
  { num: 14, content: '  <span class="text-vermillion-2 font-medium">vendor</span><span class="text-ink-4">:</span>' },
  { num: 15, content: '    <span class="text-vermillion-2 font-medium">type</span><span class="text-ink-4">:</span> <span class="text-ink-2">string</span>' },
  { num: 16, content: "" },
  { num: 17, content: '  <span class="text-vermillion-2 font-medium">bill_to</span><span class="text-ink-4">:</span>' },
  { num: 18, content: '    <span class="text-vermillion-2 font-medium">type</span><span class="text-ink-4">:</span> <span class="text-ink-2">string</span>' },
  { num: 19, content: "" },
  { num: 20, content: '  <span class="text-vermillion-2 font-medium">total_amount</span><span class="text-ink-4">:</span>' },
  { num: 21, content: '    <span class="text-vermillion-2 font-medium">type</span><span class="text-ink-4">:</span> <span class="text-ink-2">number</span>' },
  { num: 22, content: '    <span class="text-vermillion-2 font-medium">required</span><span class="text-ink-4">:</span> <span class="text-green">true</span>' },
  { num: 23, content: '    <span class="text-vermillion-2 font-medium">description</span><span class="text-ink-4">:</span> <span class="text-ink-2">Grand total incl. tax</span>' },
  { num: 24, content: '    <span class="text-vermillion-2 font-medium">aliases</span><span class="text-ink-4">:</span>  <span class="text-ink-4 italic"># alt labels</span>', added: true },
  { num: 25, content: '      <span class="text-ink-4">-</span> <span class="text-ink-2">"TOTAL"</span>', added: true },
  { num: 26, content: '      <span class="text-ink-4">-</span> <span class="text-ink-2">"BALANCE DUE"</span>', added: true },
  { num: 27, content: '      <span class="text-ink-4">-</span> <span class="text-ink-2">"AMOUNT DUE"</span>', added: true },
  { num: 28, content: "" },
  { num: 29, content: '  <span class="text-vermillion-2 font-medium">line_items</span><span class="text-ink-4">:</span>' },
  { num: 30, content: '    <span class="text-vermillion-2 font-medium">type</span><span class="text-ink-4">:</span> <span class="text-ink-2">array</span>' },
  { num: 31, content: '    <span class="text-vermillion-2 font-medium">items</span><span class="text-ink-4">:</span> <span class="text-ink-4 italic"># nested</span>' },
  { num: 32, content: "" },
  { num: 33, content: '  <span class="text-vermillion-2 font-medium">subtotal</span><span class="text-ink-4">:</span>' },
  { num: 34, content: '    <span class="text-vermillion-2 font-medium">type</span><span class="text-ink-4">:</span> <span class="text-ink-2">number</span>' },
  { num: 35, content: "" },
  { num: 36, content: '  <span class="text-vermillion-2 font-medium">tax</span><span class="text-ink-4">:</span>' },
  { num: 37, content: '    <span class="text-vermillion-2 font-medium">type</span><span class="text-ink-4">:</span> <span class="text-ink-2">number</span>' },
];

export interface ExtractionField {
  name: string;
  value: string;
  confidence: number;
}

export const MOCK_EXTRACTION: ExtractionField[] = [
  { name: "invoice_number", value: "2026-087", confidence: 0.99 },
  { name: "invoice_date", value: "2026-03-28", confidence: 0.99 },
  { name: "vendor", value: "Brighton & Co. Contractors", confidence: 0.97 },
  { name: "bill_to", value: "Vantage Capital", confidence: 0.96 },
  { name: "total_amount", value: "4,250.00", confidence: 0.98 },
  { name: "line_items", value: "2 items", confidence: 0.94 },
  { name: "subtotal", value: "3,950.00", confidence: 0.99 },
  { name: "tax", value: "300.00", confidence: 0.99 },
];

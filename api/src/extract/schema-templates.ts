/**
 * Schema templates — starting-point YAML schemas for common document types.
 *
 * The agentic schema builder uses these as foundations. When a user uploads
 * a document, we classify it (zero-cost regex) and propose the matching
 * template. The agent then refines it based on the user's instructions.
 */

export type DocType =
  | "insurance_policy"
  | "insurance_coi"
  | "invoice"
  | "contract"
  | "bank_statement"
  | "tax_form"
  | "medical_record"
  | "generic";

export const SCHEMA_TEMPLATES: Record<DocType, string> = {
  insurance_policy: `name: insurance_policy
description: Insurance policy declarations page extraction
fields:
  policy_number:
    type: string
    required: true
    extraction_guidance: "Policy number, ID, or certificate number"
  insurer_name:
    type: string
    required: true
    extraction_guidance: "Insurance company or carrier name"
  named_insured:
    type: string
    required: true
    extraction_guidance: "Primary insured party name"
  policy_type:
    type: string
    extraction_guidance: "Type of policy (e.g. Commercial, Auto, Homeowners)"
  effective_date:
    type: date
    normalize: iso8601
  expiration_date:
    type: date
    normalize: iso8601
  total_premium:
    type: number
  each_occurrence_limit:
    type: number
    extraction_guidance: "Per-occurrence coverage limit"
  general_aggregate_limit:
    type: number
    extraction_guidance: "General aggregate coverage limit"
`,

  insurance_coi: `name: acord_25_coi
description: ACORD 25 Certificate of Liability Insurance
fields:
  # Header
  producer:
    type: string
    extraction_guidance: "Insurance agency or broker name and address"
  insured_name:
    type: string
    required: true
  insured_address:
    type: string

  # General Liability
  gl_claims_made:
    type: boolean
    extraction_guidance: "Whether General Liability is claims-made (vs occurrence)"
  gl_occurrence:
    type: boolean
    extraction_guidance: "Whether General Liability is occurrence-based"
  gl_policy_number:
    type: string
  gl_eff_date:
    type: date
    normalize: iso8601
  gl_exp_date:
    type: date
    normalize: iso8601
  gl_each_occurrence:
    type: number
    extraction_guidance: "General Liability Each Occurrence limit"
  gl_damage_to_rented:
    type: number
    extraction_guidance: "Damage to Rented Premises limit"
  gl_med_exp:
    type: number
    extraction_guidance: "Medical Expense limit (per person)"
  gl_personal_adv_injury:
    type: number
  gl_general_aggregate:
    type: number
  gl_products_comp_op:
    type: number
    extraction_guidance: "Products-Completed Operations Aggregate limit"

  # Automobile Liability
  auto_any_auto:
    type: boolean
    extraction_guidance: "Whether 'Any Auto' is checked"
  auto_policy_number:
    type: string
  auto_eff_date:
    type: date
    normalize: iso8601
  auto_exp_date:
    type: date
    normalize: iso8601
  auto_combined_single_limit:
    type: number
    extraction_guidance: "Combined Single Limit per accident"

  # Umbrella / Excess Liability
  umbrella_policy_number:
    type: string
  umbrella_eff_date:
    type: date
    normalize: iso8601
  umbrella_exp_date:
    type: date
    normalize: iso8601
  umbrella_each_occurrence:
    type: number
  umbrella_aggregate:
    type: number

  # Workers Compensation
  wc_policy_number:
    type: string
  wc_eff_date:
    type: date
    normalize: iso8601
  wc_exp_date:
    type: date
    normalize: iso8601
  wc_statutory:
    type: boolean
    extraction_guidance: "Whether statutory limits apply for Workers Comp"
  wc_each_accident:
    type: number
  wc_disease_ea_employee:
    type: number
  wc_disease_policy_limit:
    type: number

  # Certificate info
  certificate_number:
    type: string
  certificate_holder:
    type: string
    extraction_guidance: "Name and address of the certificate holder"
  description_of_operations:
    type: string
    extraction_guidance: "Description of operations, locations, vehicles, or special items"
`,

  invoice: `name: invoice
description: Vendor invoice or bill extraction
fields:
  invoice_number:
    type: string
    required: true
  invoice_date:
    type: date
    required: true
    normalize: iso8601
  due_date:
    type: date
    normalize: iso8601
  vendor_name:
    type: string
    required: true
  bill_to:
    type: string
  subtotal:
    type: number
  tax_amount:
    type: number
  total_amount:
    type: number
    required: true
  payment_terms:
    type: string
    extraction_guidance: "e.g. Net 30, Due on receipt"
  purchase_order:
    type: string
`,

  contract: `name: contract
description: Service agreement or contract extraction
fields:
  contract_title:
    type: string
  parties:
    type: array
    items:
      type: string
    extraction_guidance: "Names of all parties to the agreement"
  effective_date:
    type: date
    normalize: iso8601
  termination_date:
    type: date
    normalize: iso8601
  contract_value:
    type: number
    extraction_guidance: "Total contract value or consideration amount"
  governing_law:
    type: string
    extraction_guidance: "State or jurisdiction governing the contract"
  auto_renewal:
    type: boolean
  notice_period:
    type: string
    extraction_guidance: "Required notice period for termination"
`,

  bank_statement: `name: bank_statement
description: Bank or financial statement extraction
fields:
  account_number:
    type: string
    required: true
  account_holder:
    type: string
  statement_period_start:
    type: date
    normalize: iso8601
  statement_period_end:
    type: date
    normalize: iso8601
  opening_balance:
    type: number
  closing_balance:
    type: number
  total_deposits:
    type: number
  total_withdrawals:
    type: number
  bank_name:
    type: string
`,

  tax_form: `name: tax_form
description: Tax document extraction
fields:
  form_type:
    type: string
    extraction_guidance: "e.g. W-2, 1099, 1040"
  tax_year:
    type: string
  taxpayer_name:
    type: string
    required: true
  taxpayer_id:
    type: string
    extraction_guidance: "SSN or EIN (last 4 digits only for privacy)"
  employer_name:
    type: string
  gross_income:
    type: number
  federal_tax_withheld:
    type: number
  state_tax_withheld:
    type: number
`,

  medical_record: `name: medical_record
description: Medical or healthcare document extraction
fields:
  patient_name:
    type: string
    required: true
  date_of_birth:
    type: date
    normalize: iso8601
  date_of_service:
    type: date
    normalize: iso8601
  provider_name:
    type: string
  facility_name:
    type: string
  diagnosis:
    type: string
  procedure:
    type: string
  total_charges:
    type: number
  insurance_paid:
    type: number
  patient_responsibility:
    type: number
`,

  generic: `name: document
description: General document extraction
fields:
  document_title:
    type: string
  document_date:
    type: date
    normalize: iso8601
  author_or_sender:
    type: string
  recipient:
    type: string
  reference_number:
    type: string
`,
};

export interface KVPair {
  label: string;
  value: string;
}

/**
 * Classify a document type based on KV pairs and the first portion of markdown.
 * Zero-cost regex matching — no LLM call.
 */
export function classifyDocType(
  kvPairs: KVPair[],
  markdownHead: string,
): DocType {
  const text = [
    markdownHead,
    kvPairs.map((p) => `${p.label}: ${p.value}`).join("\n"),
  ].join("\n").toLowerCase();

  // Insurance COI (check before general policy)
  if (/certificate\s+of\s+(liability\s+)?insurance|acord\s+25|certificate\s+holder/i.test(text)) {
    return "insurance_coi";
  }

  // Insurance policy
  if (/policy\s*(number|#|no)|named\s+insured|premium|deductible|coverage\s+limit|carrier|underwriter|declarations?\s+page/i.test(text)) {
    return "insurance_policy";
  }

  // Invoice
  if (/invoice\s*(number|#|no|date)|bill\s+to|subtotal|amount\s+due|vendor|purchase\s+order/i.test(text)) {
    return "invoice";
  }

  // Contract
  if (/agreement|contract|parties|whereas|obligations|term\s+and\s+condition|governing\s+law|indemnif/i.test(text)) {
    return "contract";
  }

  // Bank statement
  if (/account\s+(number|balance)|routing|statement\s+period|opening\s+balance|deposits|withdrawals/i.test(text)) {
    return "bank_statement";
  }

  // Tax form
  if (/form\s+(1099|w-2|w2|1040)|taxable|adjusted\s+gross|irs|employer\s+identification/i.test(text)) {
    return "tax_form";
  }

  // Medical
  if (/patient|diagnosis|prescription|physician|date\s+of\s+service|procedure|cpt|icd/i.test(text)) {
    return "medical_record";
  }

  return "generic";
}

export function getTemplate(docType: DocType): string {
  return SCHEMA_TEMPLATES[docType] ?? SCHEMA_TEMPLATES.generic;
}

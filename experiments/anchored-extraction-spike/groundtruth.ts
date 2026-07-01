/**
 * THROWAWAY SPIKE HARNESS — NOT PRODUCTION CODE (oss-331).
 *
 * Hand-authored ground truth: for each doc, the fields to extract (name +
 * description for the model) and, per field, the correct source location in the
 * parse spine. Locations are resolved to concrete unit ids at runtime against
 * the parsed spine, so they survive id reassignment.
 *
 * Deliberately includes the HARD cases anchoring is supposed to win:
 *   - repeated values whose correct cell is NOT the first occurrence
 *     (flagged `disambig`), where the deterministic first-match locate is wrong;
 *   - duplicated limit columns (multiple acceptable cells);
 *   - genuinely derived/summed values present in NO single unit (`derived`).
 */

import type { ParseUnit } from "../../api/src/parse/chunk.js";
import type { AnnotatedSpine } from "./spine.js";

export interface Field {
  name: string;
  desc: string;
  /** Expected correct value (the known answer). */
  value: string;
  /** Locate the acceptable source cell(s) in a table. */
  cell?: { tableIndex: number; rowLabel: string; col?: number; cols?: number[]; colHeader?: string };
  /** Locate the acceptable source in a prose line/heading. */
  line?: string;
  /** True when the value is computed and lives in no single unit. */
  derived?: boolean;
  /** Repeated value whose correct cell is not the first textual occurrence. */
  disambig?: boolean;
}

export interface DocSpec {
  slug: string;
  fields: Field[];
}

export const DOCS: DocSpec[] = [
  {
    slug: "dc_ho_dec",
    fields: [
      { name: "dwelling_limit", desc: "Coverage (A) Dwelling limit of coverage (dollar amount)", value: "$450,000", cell: { tableIndex: 0, rowLabel: "(A) Dwelling", colHeader: "Limits of Coverage" } },
      { name: "other_structures_limit", desc: "Coverage (B) Other Structures limit", value: "$45,000", cell: { tableIndex: 0, rowLabel: "(B) Other Structures", colHeader: "Limits of Coverage" } },
      { name: "personal_property_limit", desc: "Coverage (C) Personal Property limit", value: "$225,000", cell: { tableIndex: 0, rowLabel: "(C) Personal Property", colHeader: "Limits of Coverage" } },
      { name: "loss_of_use_limit", desc: "Coverage (D) Loss of Use limit", value: "$90,000", cell: { tableIndex: 0, rowLabel: "(D) Loss of Use", colHeader: "Limits of Coverage" } },
      { name: "liability_limit", desc: "Coverage (E) Liability limit (dollar amount only)", value: "$300,000", cell: { tableIndex: 0, rowLabel: "(E) Liability", col: 3 } },
      { name: "medical_limit", desc: "Coverage (F) Medical limit (dollar amount only)", value: "$1,000", cell: { tableIndex: 0, rowLabel: "(F) Medical", col: 3 } },
      { name: "deductible", desc: "The Section 1 & 2 policy deductible amount", value: "$1,000", line: "Deductible", disambig: true },
      { name: "policy_number", desc: "The policy number", value: "254H089SJ425", line: "Policy Number" },
      { name: "named_insured", desc: "The named insured / policy holder name", value: "John Doe and Susy Doe", line: "John Doe and Susy Doe" },
      { name: "policy_type", desc: "The policy type / form (e.g. HO-3)", value: "HO-3", line: "Policy Type" },
      { name: "total_coverage_limits", desc: "The arithmetic total of Coverage A+B+C+D limits (sum them)", value: "$810,000", derived: true },
    ],
  },
  {
    slug: "fl_sample_dec",
    fields: [
      { name: "coverage_a_limit", desc: "Coverage A - Dwelling limit of liability", value: "$160,000", cell: { tableIndex: 0, rowLabel: "Coverage A - Dwelling", cols: [2, 3] } },
      { name: "coverage_a_premium", desc: "Coverage A - Dwelling premium", value: "$859.00", cell: { tableIndex: 0, rowLabel: "Coverage A - Dwelling", col: 4 } },
      { name: "coverage_c_limit", desc: "Coverage C - Personal Property limit of liability", value: "$104,250", cell: { tableIndex: 0, rowLabel: "Coverage C - Personal Property", cols: [2, 3] } },
      { name: "coverage_e_limit", desc: "Coverage E - Personal Liability limit", value: "$100,000", cell: { tableIndex: 0, rowLabel: "Coverage E - Personal Liability", cols: [2, 3] } },
      { name: "coverage_b_limit", desc: "Coverage B - Other Structures limit of liability", value: "$3,200", cell: { tableIndex: 0, rowLabel: "Coverage B - Other Structures", cols: [2, 3] } },
      { name: "hurricane_deductible", desc: "The HURRICANE deductible amount (2% of Coverage A row)", value: "$3,200", cell: { tableIndex: 0, rowLabel: "HURRICANE: 2% OF Coverage A", cols: [2, 3] }, disambig: true },
      { name: "all_other_perils_deductible", desc: "The All Other Perils (non-hurricane) deductible amount", value: "$1,000", cell: { tableIndex: 0, rowLabel: "All Other Perils", cols: [2, 3] } },
      { name: "medical_payments_limit", desc: "Coverage F - Medical Payments limit of liability", value: "$1,000", cell: { tableIndex: 0, rowLabel: "Coverage F - Medical Payments", cols: [2, 3] }, disambig: true },
      { name: "policy_number", desc: "The policy number", value: "FHO295000", line: "POLICY NO." },
      { name: "total_section_i_limits", desc: "Arithmetic total of Coverage A+B+C+D limits (sum them)", value: "$288,300", derived: true },
    ],
  },
  {
    slug: "chubb_bop",
    fields: [
      { name: "building_limit", desc: "The Building limit of insurance", value: "$244,525", cell: { tableIndex: 1, rowLabel: "Building", col: 3 } },
      { name: "building_premium", desc: "The Building coverage premium", value: "$633.00", cell: { tableIndex: 1, rowLabel: "Building", col: 7 } },
      { name: "bpp_limit", desc: "The Business Personal Property limit of insurance", value: "$100,000", cell: { tableIndex: 1, rowLabel: "Business Personal Property", col: 3 } },
      { name: "building_deductible", desc: "The Building coverage deductible", value: "$1,000", cell: { tableIndex: 1, rowLabel: "Building", col: 4 } },
      { name: "bpp_deductible", desc: "The Business Personal Property deductible", value: "$1,000", cell: { tableIndex: 1, rowLabel: "Business Personal Property", col: 4 }, disambig: true },
      { name: "building_valuation", desc: "The Building coverage valuation basis", value: "Replacement Cost", cell: { tableIndex: 1, rowLabel: "Building", col: 5 } },
      { name: "total_building_bpp_premium", desc: "Arithmetic total of Building + Business Personal Property premiums (sum them)", value: "$1,037.00", derived: true },
    ],
  },
];

const norm = (s: string): string => s.replace(/[$,\s]/g, "").toLowerCase();

/** Cells belonging to one table, indexed by (row, col). */
function tableCells(units: ParseUnit[], tableIndex: number): ParseUnit[] {
  const id = `p1-t${tableIndex}`;
  return units.filter((u) => u.table?.tableId === id);
}

/**
 * Resolve the set of ACCEPTABLE source unit ids for a field. Empty array means
 * "no single unit is a correct source" (derived values → correct citation is
 * null). Multiple ids handle duplicated columns / repeated identical cells.
 */
export function acceptableUnits(spine: AnnotatedSpine, f: Field): string[] {
  if (f.derived) return [];

  if (f.line) {
    return spine.units
      .filter(
        (u) =>
          (u.role === "line" || u.role === "heading") &&
          u.text.toLowerCase().includes(f.line!.toLowerCase()) &&
          norm(u.text).includes(norm(f.value)),
      )
      .map((u) => u.id);
  }

  if (f.cell) {
    const cells = tableCells(spine.units, f.cell.tableIndex);
    // Target columns.
    let cols: number[];
    if (f.cell.cols != null) {
      cols = f.cell.cols;
    } else if (f.cell.col != null) {
      cols = [f.cell.col];
    } else {
      const hdr = f.cell.colHeader!.toLowerCase();
      cols = [
        ...new Set(
          cells
            .filter((c) => c.text.toLowerCase().includes(hdr))
            .map((c) => c.table!.col),
        ),
      ];
    }
    // Target row: the row containing the row label.
    const rowNum = cells.find((c) => c.text.toLowerCase().includes(f.cell!.rowLabel.toLowerCase()))
      ?.table?.row;
    if (rowNum == null || cols.length === 0) return [];
    return cells
      .filter((c) => c.table!.row === rowNum && cols.includes(c.table!.col))
      .map((c) => c.id);
  }

  return [];
}

/** Does the value appear verbatim (normalized) in at least one single unit? */
export function valueInSingleUnit(spine: AnnotatedSpine, value: string): boolean {
  const n = norm(value);
  return spine.units.some((u) => u.text && norm(u.text).includes(n));
}

export { norm };

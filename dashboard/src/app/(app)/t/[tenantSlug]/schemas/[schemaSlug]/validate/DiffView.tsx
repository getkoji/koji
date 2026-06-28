// Structured expected-vs-got diff rendering for the Validate page.
//
// The diff shapes mirror the backend in koji/api/src/extract/value-compare.ts.
// Scalar fields render inline ("expected X got Y"); array and nested-object
// fields render a per-element / per-key structured diff so the reviewer sees
// exactly what differs instead of "[object Object]".

export interface ScalarDiff { kind: "scalar"; expected: string; got: string; match: boolean; }

export type ArrayElemDiff =
  | { status: "matched"; expected: string }
  | { status: "changed"; expected: string; got: string; diff: ValueDiff }
  | { status: "missing"; expected: string }
  | { status: "extra"; got: string };

export interface ArrayDiff {
  kind: "array";
  expectedCount: number;
  gotCount: number;
  matchedCount: number;
  score: number;
  elements: ArrayElemDiff[];
}

export interface ObjectFieldDiff { key: string; expected: string; got: string; diff: ValueDiff; }
export interface ObjectDiff { kind: "object"; score: number; fields: ObjectFieldDiff[]; }

export type ValueDiff = ScalarDiff | ArrayDiff | ObjectDiff;

export interface FailingDoc { id: string; filename: string; diff: ValueDiff; score: number; confidence: number; }

export function DiffView({ diff }: { diff: ValueDiff }) {
  if (diff.kind === "scalar") {
    return (
      <span className="break-all">
        <span className="text-ink-4">expected </span>
        <span className="text-green">{diff.expected}</span>
        <span className="text-ink-4"> got </span>
        <span className="text-vermillion-2">{diff.got}</span>
      </span>
    );
  }

  if (diff.kind === "object") {
    if (diff.fields.length === 0) return <span className="text-ink-4">no field differences</span>;
    return (
      <div className="space-y-0.5">
        {diff.fields.map((f) => (
          <div key={f.key} className="break-all">
            <span className="text-ink-3">{f.key}: </span>
            <span className="text-green">{f.expected}</span>
            <span className="text-ink-4"> → </span>
            <span className="text-vermillion-2">{f.got}</span>
          </div>
        ))}
      </div>
    );
  }

  // array
  const changed = diff.elements.filter((e) => e.status === "changed") as Extract<ArrayElemDiff, { status: "changed" }>[];
  const missing = diff.elements.filter((e) => e.status === "missing") as Extract<ArrayElemDiff, { status: "missing" }>[];
  const extra = diff.elements.filter((e) => e.status === "extra") as Extract<ArrayElemDiff, { status: "extra" }>[];
  return (
    <div className="space-y-1">
      <div className="text-ink-4">
        expected <span className="text-ink-3">{diff.expectedCount}</span>, got <span className="text-ink-3">{diff.gotCount}</span>
        {diff.matchedCount > 0 && <span className="text-green"> · {diff.matchedCount} matched</span>}
      </div>
      {changed.map((e, i) => (
        <div key={`c${i}`} className="pl-3">
          <span className="text-vermillion-2">~ changed</span>
          <div className="pl-3"><DiffView diff={e.diff} /></div>
        </div>
      ))}
      {missing.length > 0 && (
        <div className="pl-3">
          <div className="text-vermillion-2">✗ missing in got:</div>
          {missing.map((e, i) => <div key={`m${i}`} className="pl-3 text-green break-all">{e.expected}</div>)}
        </div>
      )}
      {extra.length > 0 && (
        <div className="pl-3">
          <div className="text-vermillion-2">+ unexpected in got:</div>
          {extra.map((e, i) => <div key={`x${i}`} className="pl-3 text-vermillion-2 break-all">{e.got}</div>)}
        </div>
      )}
    </div>
  );
}

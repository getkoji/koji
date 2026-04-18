const HEADER_WIDTHS = [72, 88, 64, 96, 80, 72, 60];
const ROW_WIDTHS = [
  [96, 72, 48, 80, 64, 88],
  [64, 104, 56, 72, 96, 48],
  [88, 56, 80, 48, 72, 104],
  [112, 80, 64, 96, 56, 72],
  [72, 96, 88, 64, 80, 48],
  [80, 64, 72, 112, 88, 56],
];

export function TableSkeleton({ columns = 5, rows = 6 }: { columns?: number; rows?: number }) {
  return (
    <div className="animate-pulse">
      <div className="flex gap-4 px-4 py-2.5 border-b border-border">
        {Array.from({ length: columns }).map((_, i) => (
          <div key={i} className="h-2 bg-cream-3 rounded-sm" style={{ width: HEADER_WIDTHS[i % HEADER_WIDTHS.length] }} />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, row) => (
        <div key={row} className="flex gap-4 px-4 py-3 border-b border-dotted border-border">
          {Array.from({ length: columns }).map((_, col) => (
            <div key={col} className="h-3 bg-cream-2 rounded-sm" style={{ width: ROW_WIDTHS[row % ROW_WIDTHS.length]![col % 6] }} />
          ))}
        </div>
      ))}
    </div>
  );
}

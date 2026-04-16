export function KojiLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 128 128"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={className}
    >
      <ellipse
        cx="40"
        cy="84"
        rx="12"
        ry="25"
        transform="rotate(-22 40 84)"
        fill="currentColor"
      />
      <ellipse
        cx="88"
        cy="84"
        rx="12"
        ry="25"
        transform="rotate(22 88 84)"
        fill="currentColor"
      />
      <ellipse cx="64" cy="42" rx="12" ry="25" fill="var(--vermillion)" />
    </svg>
  );
}

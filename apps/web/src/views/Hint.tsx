/** A "?" that shows its explanation on hover, or on focus and tap where there is no hover. */
export function Hint({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="hint-q" tabIndex={0} role="button" aria-label={label}>
      ?
      <span className="hint-q-body" role="tooltip">
        {children}
      </span>
    </span>
  );
}

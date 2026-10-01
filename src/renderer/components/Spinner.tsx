interface SpinnerProps {
  className?: string;
}

/** 轻量加载指示器。 */
export function Spinner({ className = 'h-4 w-4' }: SpinnerProps) {
  return (
    <div
      aria-hidden="true"
      className={`state-spinner animate-spin rounded-full border-2 border-muted border-t-transparent ${className}`}
    />
  );
}

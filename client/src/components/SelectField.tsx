import { ChevronDown } from 'lucide-react';
import type { SelectHTMLAttributes } from 'react';

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  selectClassName?: string;
}

export default function SelectField({
  className = '',
  selectClassName = '',
  children,
  disabled,
  ...props
}: SelectFieldProps) {
  return (
    <span className={`relative inline-flex min-w-0 ${className}`}>
      <select
        disabled={disabled}
        className={`h-10 w-full appearance-none rounded-lg border border-border bg-bg-base px-3 pr-9 text-sm text-text-main outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50 ${selectClassName}`}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
    </span>
  );
}

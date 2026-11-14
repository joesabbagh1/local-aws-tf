import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { AwsServiceIcon } from './AwsServiceIcon';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink hover:bg-accent-hover font-medium',
  secondary: 'bg-raised text-fg border border-line hover:bg-overlay hover:border-line-strong',
  ghost: 'text-fg-muted hover:text-fg hover:bg-raised',
  danger: 'text-fg-muted hover:text-err hover:bg-err/10',
};

export function Button({
  variant = 'secondary',
  size = 'sm',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md' }) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md whitespace-nowrap transition-colors',
        'disabled:opacity-40 disabled:pointer-events-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-[14px]',
        BUTTON_VARIANTS[variant],
        className
      )}
      {...props}
    />
  );
}

export function IconButton({
  variant = 'ghost',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'ghost' | 'danger' }) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center justify-center w-7 h-7 rounded-md shrink-0 transition-colors',
        'disabled:opacity-30 disabled:pointer-events-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent',
        BUTTON_VARIANTS[variant],
        className
      )}
      {...props}
    />
  );
}

/** Shared look for text inputs, selects and textareas. */
export const fieldCls =
  'w-full bg-base border border-line rounded-md px-2.5 py-1.5 text-xs text-fg placeholder:text-fg-faint ' +
  'hover:border-line-strong focus:outline-none focus:border-accent/70 transition-colors';

export const monoFieldCls = `${fieldCls} font-mono`;

export function Section({
  title,
  aside,
  children,
  className,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('px-4 py-4 border-b border-line last:border-b-0', className)}>
      {(title || aside) && (
        <div className="flex items-center justify-between gap-2 mb-3 min-h-[20px]">
          <h3 className="text-xs font-medium text-fg-muted">{title}</h3>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export function Switch({
  checked,
  onChange,
  title,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative w-7 h-4 rounded-full shrink-0 transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent',
        checked ? 'bg-accent' : 'bg-overlay border border-line-strong'
      )}
    >
      <span
        className={cn(
          'absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full transition-[left]',
          checked ? 'left-[14px] bg-accent-ink' : 'left-[2px] bg-fg-muted'
        )}
      />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex p-0.5 rounded-md bg-base border border-line', className)}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            'flex-1 h-6 px-2.5 rounded-[5px] text-xs whitespace-nowrap inline-flex items-center justify-center gap-1.5 transition-colors',
            value === opt.value ? 'bg-overlay text-fg' : 'text-fg-muted hover:text-fg'
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/** Environment colour marker; hollow when the environment is off or its emulator is down. */
export function EnvDot({ color, hollow, className }: { color: string; hollow?: boolean; className?: string }) {
  return (
    <span
      className={cn('inline-block w-2 h-2 rounded-full shrink-0', className)}
      style={hollow ? { boxShadow: `inset 0 0 0 1.5px ${color}` } : { backgroundColor: color }}
    />
  );
}

export function ServiceGlyph({
  iconName,
  color,
  size = 'md',
}: {
  iconName: string;
  color: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const box = size === 'sm' ? 'w-6 h-6' : size === 'md' ? 'w-7 h-7' : 'w-9 h-9';
  const icon = size === 'lg' ? 'w-[18px] h-[18px]' : 'w-3.5 h-3.5';
  return (
    <span className={cn(box, 'rounded-md bg-overlay border border-line flex items-center justify-center shrink-0')} style={{ color }}>
      <AwsServiceIcon iconName={iconName} className={icon} />
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="font-mono text-[11.5px] px-1 py-px rounded border border-line text-fg-muted">{children}</kbd>
  );
}

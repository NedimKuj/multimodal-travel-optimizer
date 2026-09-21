import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

import { clsx } from "clsx";

export function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium text-[var(--ink)]">{label}</span>
      {children}
      {hint !== undefined ? (
        <span className="text-xs text-[var(--ink-muted)]">{hint}</span>
      ) : null}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className, ...rest } = props;
  return (
    <input
      {...rest}
      className={clsx(
        "rounded-md border border-[var(--line)] bg-[var(--bg-elevated)] px-3 py-2 text-[var(--ink)]",
        "placeholder:text-[var(--ink-muted)] disabled:opacity-60",
        className,
      )}
    />
  );
}

export function TextSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className, children, ...rest } = props;
  return (
    <select
      {...rest}
      className={clsx(
        "rounded-md border border-[var(--line)] bg-[var(--bg-elevated)] px-3 py-2 text-[var(--ink)]",
        "disabled:opacity-60",
        className,
      )}
    >
      {children}
    </select>
  );
}

export function CheckboxRow({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly label: string;
  readonly hint?: string;
  readonly disabled?: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 text-sm">
      <input
        type="checkbox"
        className="mt-1"
        checked={checked}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      <span>
        <span className="font-medium text-[var(--ink)]">{label}</span>
        {hint !== undefined ? (
          <span className="mt-0.5 block text-xs text-[var(--ink-muted)]">{hint}</span>
        ) : null}
      </span>
    </label>
  );
}

export function Button({
  variant = "primary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: "primary" | "secondary" | "ghost";
}) {
  return (
    <button
      {...props}
      className={clsx(
        "inline-flex items-center justify-center rounded-md px-4 py-2.5 text-sm font-semibold transition",
        "disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary" &&
          "bg-[var(--accent)] text-[var(--accent-ink)] hover:brightness-110",
        variant === "secondary" &&
          "border border-[var(--line)] bg-[var(--bg-elevated)] text-[var(--ink)] hover:bg-white",
        variant === "ghost" && "text-[var(--accent)] hover:underline",
        className,
      )}
    />
  );
}

export function Panel({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <section
      className={clsx(
        "rounded-lg border border-[var(--line)] bg-[var(--bg-elevated)] p-4 sm:p-5",
        className,
      )}
    >
      {children}
    </section>
  );
}

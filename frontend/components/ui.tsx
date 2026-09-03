import { ButtonHTMLAttributes, InputHTMLAttributes, LabelHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import Link, { LinkProps } from "next/link";

export function cx(...classes: Array<string | false | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx(
        "rounded-lg border border-line bg-white/60 p-6 shadow-sm",
        className,
      )}
      {...props}
    />
  );
}

export function Button({
  className,
  variant = "primary",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" }) {
  const variants = {
    // Matches avos-solutions.com's .btn-primary hover (dark -> --signal-dim gold), same as the
    // avos-erp / avos-licensing frontends this design system is shared with.
    primary: "bg-ink text-paper hover:bg-signal-dim",
    secondary: "bg-transparent text-ink border border-line hover:bg-paper-dim",
    danger: "bg-brass text-paper hover:opacity-90",
  };
  return (
    <button
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}

export function LinkButton({
  className,
  variant = "primary",
  ...props
}: LinkProps & { className?: string; children: React.ReactNode; variant?: "primary" | "secondary" }) {
  const variants = {
    primary: "bg-ink text-paper hover:bg-signal-dim",
    secondary: "bg-transparent text-ink border border-line hover:bg-paper-dim",
  };
  return (
    <Link
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cx(
        "w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink placeholder:text-slate focus:border-signal focus:outline-none",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cx(
        "w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink placeholder:text-slate focus:border-signal focus:outline-none",
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx(
        "w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink focus:border-signal focus:outline-none",
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cx("eyebrow mb-1.5 block", className)} {...props} />;
}

export function PageHeader({
  eyebrow,
  title,
  action,
}: {
  eyebrow: string;
  title: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="no-print mb-8 flex items-center justify-between">
      <div>
        <p className="eyebrow mb-1">{eyebrow}</p>
        <h1 className="text-2xl">{title}</h1>
      </div>
      {action}
    </div>
  );
}

const STATUS_COLORS: Record<string, string> = {
  Unclaimed: "bg-slate/15 text-slate",
  Active: "bg-signal/20 text-signal-dim",
  Suspended: "bg-brass/15 text-brass",
  Expired: "bg-brass/15 text-brass",
  Revoked: "bg-brass/15 text-brass",
  Trial: "bg-slate/15 text-slate",
  Subscription: "bg-signal/20 text-signal-dim",
  Perpetual: "bg-ink/10 text-ink",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cx(
        "mono inline-block rounded-full px-2.5 py-0.5 text-xs font-medium",
        STATUS_COLORS[status] ?? "bg-line text-slate",
      )}
    >
      {status}
    </span>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4" onClick={onClose}>
      <Card className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg">{title}</h2>
          <button className="mono text-xs text-slate transition-colors hover:text-ink" onClick={onClose} aria-label="Close">
            close
          </button>
        </div>
        {children}
      </Card>
    </div>
  );
}

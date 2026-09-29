import type { ButtonHTMLAttributes, ReactNode } from "react";

/** Brand-token primitives shared by the auth islands. */

export const inputClass =
  "w-full rounded-xl border border-line bg-card px-3.5 py-2.5 text-ink placeholder:text-faint focus:border-accent focus:outline-none";

type Tone = "primary" | "secondary" | "danger";

const toneClass: Record<Tone, string> = {
  primary: "bg-accent text-on-accent hover:opacity-90",
  secondary: "border border-line-strong bg-card text-ink hover:bg-accent-soft",
  danger: "border border-line-strong bg-card text-warning hover:bg-accent-soft",
};

export function Button({ tone = "primary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone }) {
  return (
    <button
      type="button"
      {...props}
      className={`rounded-full px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${toneClass[tone]} ${className}`}
    />
  );
}

export function Card({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-card border border-line bg-card p-6 shadow-card" aria-label={title}>
      <h2 className="font-display text-2xl leading-tight">{title}</h2>
      {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function Notice({ tone, children }: { tone: "error" | "success" | "info"; children: ReactNode }) {
  const color = tone === "error" ? "text-warning" : tone === "success" ? "text-success" : "text-muted";
  return (
    <p role={tone === "error" ? "alert" : "status"} className={`mt-3 text-sm ${color}`}>
      {children}
    </p>
  );
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

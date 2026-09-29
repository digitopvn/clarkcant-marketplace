import { useEffect, useState } from "react";

type ThemeChoice = "system" | "light" | "dark";

const ORDER: readonly ThemeChoice[] = ["system", "light", "dark"];
const LABELS: Record<ThemeChoice, string> = { system: "System", light: "Light", dark: "Dark" };

function readStoredChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem("theme");
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function applyChoice(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;
  try {
    if (choice === "system") localStorage.removeItem("theme");
    else localStorage.setItem("theme", choice);
  } catch {
    // Storage unavailable: the choice still applies for this page view.
  }
}

/** Cycles System → Light → Dark. The head script applies the stored choice before paint; this only changes it. */
export default function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>("system");

  useEffect(() => {
    setChoice(readStoredChoice());
  }, []);

  const next = ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length] ?? "system";

  return (
    <button
      type="button"
      className="rounded-full px-3 py-1.5 text-muted hover:bg-accent-soft hover:text-ink"
      aria-label={`Theme: ${LABELS[choice]}. Switch to ${LABELS[next]}.`}
      onClick={() => {
        applyChoice(next);
        setChoice(next);
      }}
    >
      {LABELS[choice]}
    </button>
  );
}

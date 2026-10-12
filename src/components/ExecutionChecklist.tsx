// Pre-execution checklist (presentation only). Copies the engine host automation view; never decides.
import type { AutomationView } from "@/core/enginehost/automationState";

const MARK = { PASS: "✓", FAIL: "✕", UNKNOWN: "?" } as const;
const TONE = { PASS: "text-primary", FAIL: "text-destructive", UNKNOWN: "text-muted-foreground" } as const;

export function ExecutionChecklist({ automation }: { automation: AutomationView | null | undefined }) {
  if (!automation) {
    return (
      <p data-testid="exec-checklist-unavailable" className="text-xs text-muted-foreground">
        Checklist belum tersedia dari Engine Host · EXECUTION BLOCKED
      </p>
    );
  }
  const blocked = automation.verdict !== "CLEARED";
  return (
    <div data-testid="exec-checklist" className="space-y-1 text-xs">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">Tahap: {automation.stage}</span>
        <span data-testid="exec-checklist-verdict" className={blocked ? "font-semibold text-destructive" : "font-semibold text-primary"}>
          {blocked ? "EXECUTION BLOCKED" : "CLEARED"}
        </span>
      </div>
      <ul className="space-y-0.5">
        {automation.checklist.map((c) => (
          <li key={c.key} data-state={c.state} className="flex items-center gap-2">
            <span className={`w-3 text-center ${TONE[c.state]}`} aria-hidden>{MARK[c.state]}</span>
            <span>{c.label}</span>
            <span className="ml-auto text-muted-foreground">
              {c.key === "SESSION_ARM" && c.state !== "PASS" ? "SESI BELUM DI-ARM" : c.state}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

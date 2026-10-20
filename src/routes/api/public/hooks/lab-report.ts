import { createFileRoute } from "@tanstack/react-router";
import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

// Single hourly report sender (managed schedule). Read-only on trading data; deduped per WIB hour slot.
export const Route = createFileRoute("/api/public/hooks/lab-report")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const fail = await authenticateCronRequest(request);
        if (fail) return fail;
        const { runLabReport } = await import("@/lib/report/labReport.server");
        const r = await runLabReport({ trigger: "HOURLY", telegram: true, returnFile: false });
        return Response.json(r, { status: r.ok ? 200 : 502 });
      },
    },
  },
});

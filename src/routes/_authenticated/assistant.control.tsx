import { createFileRoute } from "@tanstack/react-router";
import { AssistantReportSection } from "@/components/AssistantReportSection";
import { ExecutionControlPanel } from "@/components/ExecutionControlPanel";
import { DemoLabPanel } from "@/components/DemoLabPanel";
import { EngineMonitoringPanel } from "@/components/EngineMonitoringPanel";
import { EngineEventsPanel } from "@/components/EngineEventsPanel";

export const Route = createFileRoute("/_authenticated/assistant/control")({
  head: () => ({
    meta: [
      { title: "Kontrol Demo & Audit — Personal AI Trading OS" },
      {
        name: "description",
        content: "Kendali eksekusi demo, audit perubahan, Demo Execution Lab dan aktivitas engine.",
      },
      { property: "og:title", content: "Kontrol Demo & Audit — Personal AI Trading OS" },
      {
        property: "og:description",
        content:
          "Pantau kendali akun demo dan bukti aktivitas engine; eksekusi real tetap tidak tersedia.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ControlPage,
});

function ControlPage() {
  return (
    <div className="assistant-reports min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
      <div className="mx-auto w-full max-w-3xl space-y-7 pb-6">
        <header className="space-y-2">
          <h2 className="text-xl font-semibold">Kontrol</h2>
          <p className="text-sm text-muted-foreground">
            Kendali akun demo, riwayat perubahan, dan pemantauan aktivitas engine.
          </p>
        </header>
        <AssistantReportSection
          title="Engine Monitoring (Shadow)"
          description="Status engine, versi kode di VPS, umur candle per timeframe, dan keputusan terakhir. Mode shadow tidak mengirim order."
        >
          <EngineMonitoringPanel />
        </AssistantReportSection>
        <AssistantReportSection
          title="Execution Control & Audit"
          description="Lihat status agent dan MT5, batas risiko, serta riwayat perubahan. Tombol kendali tersedia sesuai hak akses akun."
        >
          <ExecutionControlPanel />
        </AssistantReportSection>
        <AssistantReportSection
          title="Demo Execution Lab"
          description="Pantau modal, posisi, hasil order, dan log eksekusi akun demo. Pengaturan kendalinya ada di Execution Control di atas."
        >
          <DemoLabPanel />
        </AssistantReportSection>
        <AssistantReportSection
          title="Engine Proof of Life"
          description="Lihat aktivitas engine, alasan pemblokiran, eksekusi terakhir, dan heartbeat untuk memeriksa apakah sistem masih melapor."
        >
          <EngineEventsPanel />
        </AssistantReportSection>
      </div>
    </div>
  );
}

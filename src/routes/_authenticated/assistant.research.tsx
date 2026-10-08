import { createFileRoute } from "@tanstack/react-router";
import { AssistantReportSection } from "@/components/AssistantReportSection";
import { JournalIntelligencePanel } from "@/components/JournalIntelligencePanel";
import { PerformancePanel } from "@/components/PerformancePanel";
import { TradeReviewPanel } from "@/components/TradeReviewPanel";

export const Route = createFileRoute("/_authenticated/assistant/research")({
  head: () => ({ meta: [
    { title: "Riset Jurnal & Performa — Personal AI Trading OS" },
    { name: "description", content: "Journal Intelligence, Performance Intelligence dan Trade Review untuk analisis historis trading." },
    { property: "og:title", content: "Riset Jurnal & Performa — Personal AI Trading OS" },
    { property: "og:description", content: "Tinjau hasil historis, ukuran sampel dan kepatuhan trade tanpa mengubah aturan engine." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  component: ResearchPage,
});

function ResearchPage() {
  return <div className="assistant-reports min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
    <div className="mx-auto w-full max-w-3xl space-y-7 pb-6">
      <header className="space-y-2">
        <h2 className="text-xl font-semibold">Riset</h2>
        <p className="text-sm text-muted-foreground">Analisis hasil historis untuk evaluasi, bukan sinyal atau perubahan aturan trading.</p>
      </header>
      <AssistantReportSection title="Journal Intelligence" description="Ringkas jurnal berdasarkan kondisi pasar, pendekatan, kualitas setup, dan pola kegagalan dari data yang tersimpan.">
        <JournalIntelligencePanel />
      </AssistantReportSection>
      <AssistantReportSection title="Performance Intelligence" description="Bandingkan win rate, hasil dalam R, dan kepatuhan trade. Jumlah sampel ditampilkan agar hasil tidak disimpulkan terlalu cepat.">
        <PerformancePanel />
      </AssistantReportSection>
      <AssistantReportSection title="Trade Review" description="Tinjau trade yang sudah ditutup, kepatuhan terhadap aturan, dan ulasan AI berdasarkan bukti yang tersedia.">
        <TradeReviewPanel />
      </AssistantReportSection>
    </div>
  </div>;
}
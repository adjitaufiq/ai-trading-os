import { createFileRoute } from "@tanstack/react-router";
import { Radar } from "lucide-react";

export const Route = createFileRoute("/_authenticated/assistant/")({
  component: () => <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
    <Radar className="size-10 text-bull" aria-hidden />
    <h1 className="text-lg font-semibold">AI Trading Assistant</h1>
    <p className="max-w-md text-sm text-muted-foreground">
      Pilih atau buat thread di kiri. Thread XAUUSD/BTCUSD hanya membaca data live simbol itu dari Engine Host;
      thread Knowledge Base menjelaskan istilah Radar, regime, horizon, events, dan paper trading.
    </p>
  </div>,
});

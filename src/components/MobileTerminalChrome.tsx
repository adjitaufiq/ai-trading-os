import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Menu,
  Zap,
  ZapOff,
  ArrowLeft,
  NotebookPen,
  FlaskConical,
  SlidersHorizontal,
  Activity,
  BookOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useMobileTerminal } from "./MobileTerminalContext";
import { Direction, Lamp, mobileLamps } from "./MobileTradingView";
import robot from "@/assets/ai-robot-head-3d.png.asset.json";
export function MobileTerminalChrome({
  selectedSymbol,
  onSymbol,
  engineStatus,
  engineDetail,
  hasAlerts,
}: {
  selectedSymbol: string;
  onSymbol: (s: "XAUUSD" | "BTCUSD") => void;
  engineStatus: string;
  engineDetail: string;
  hasAlerts: boolean;
}) {
  const m = useMobileTerminal();
  const [drawer, setDrawer] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  if (!m) return null;
  const q = m.observation?.symbol === selectedSymbol ? m.observation : null;
  const report = m.report?.facts.symbol === selectedSymbol ? m.report : null;
  const lamps = mobileLamps(
    report?.snapshot ?? null,
    report?.facts ?? null,
    engineStatus,
    !!q?.connected && !!q.fresh,
  );
  const accessory = (name: string) => {
    m.setAccessory(name);
    setDrawer(false);
  };
  return (
    <>
      <header className="mobile-terminal-header">
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Buka menu"
            onClick={() => setDrawer(true)}
          >
            <Menu className="size-5" />
          </Button>
          <div className="min-w-0">
            <div className="mobile-label">PERSONAL AI TRADER</div>
            <div className="mt-1 flex gap-4">
              {(["XAUUSD", "BTCUSD"] as const).map((s) => (
                <Button
                  key={s}
                  variant="ghost"
                  onClick={() => onSymbol(s)}
                  aria-pressed={s === selectedSymbol}
                  className={`h-7 rounded-none border-b px-0 font-mono text-sm ${s === selectedSymbol ? "border-primary text-foreground" : "border-transparent text-muted-foreground"}`}
                >
                  {s}
                </Button>
              ))}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Detail koneksi"
            title="Detail koneksi"
            className={
              q?.connected && q.fresh
                ? "text-bull"
                : engineStatus === "OFFLINE"
                  ? "text-bear"
                  : "text-warn"
            }
            onClick={() =>
              setDetail(
                `${engineDetail}\n${q?.detail ?? "Menunggu feed broker"}\n${q && !q.fresh ? "Harga terakhir / belum tervalidasi terkini" : ""}`,
              )
            }
          >
            {q?.connected && q.fresh ? <Zap /> : <ZapOff />}
          </Button>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-4 px-2">
          {[
            ["BID", q?.bid],
            ["ASK", q?.ask],
            ["SPREAD", q?.spread],
          ].map(([k, v]) => (
            <div key={k}>
              <div className="mobile-label">{k}</div>
              <div
                key={v}
                className={`mobile-quote mt-1 truncate font-mono text-lg ${q && !q.fresh ? "text-muted-foreground" : ""}`}
              >
                {v ?? "—"}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-2 flex border-y border-border">
          {lamps.map((l) => (
            <Lamp key={l.label} {...l} onClick={() => setDetail(l.detail)} />
          ))}
        </div>
        <div className="grid grid-cols-3 gap-3 px-2 py-3 text-[11px]">
          <div>
            <span className="mobile-label">BIAS </span>
            <Direction value={report?.snapshot?.bias.state} />
          </div>
          <div className="truncate">
            <span className="mobile-label">SETUP </span>
            {report?.snapshot?.setup.state === "ACTIVE" ? "ACTIVE" : "WAIT"}
          </div>
          <div className="truncate">
            <span className="mobile-label">SIGNAL </span>
            {report?.snapshot?.signal.state ?? "—"}
          </div>
        </div>
        {m.accessory && (
          <div className="flex items-center gap-2 border-t border-border pt-2">
            <Button
              size="icon"
              variant="ghost"
              aria-label="Kembali ke Trade"
              onClick={() => m.setAccessory(null)}
            >
              <ArrowLeft />
            </Button>
            <h2 className="text-sm font-semibold">{m.accessory}</h2>
          </div>
        )}
      </header>
      <Dialog open={drawer} onOpenChange={setDrawer}>
        <DialogContent className="mobile-menu-dialog left-0 top-0 translate-x-0 translate-y-0">
          <DialogTitle>Personal AI Trader</DialogTitle>
          <DialogDescription>MONITOR_ONLY · terminal baca-saja</DialogDescription>
          <div className="space-y-5">
            <MenuGroup title="Catatan">
              <MenuAction icon={NotebookPen} label="Jurnal" onClick={() => accessory("Jurnal")} />
              <MenuAction
                icon={FlaskConical}
                label="Backtest"
                onClick={() => accessory("Backtest")}
              />
            </MenuGroup>
            <MenuGroup title="Analisis">
              <Button asChild variant="ghost" className="w-full justify-start">
                <Link to="/assistant/research">
                  <Activity />
                  Riset
                </Link>
              </Button>
              <MenuAction
                icon={Activity}
                label="Detail Radar & Teknikal"
                onClick={() => accessory("Detail Radar & Teknikal")}
              />
            </MenuGroup>
            <MenuGroup title="Sistem">
              <Button asChild variant="ghost" className="w-full justify-start">
                <Link to="/assistant/control">
                  <SlidersHorizontal />
                  Kontrol
                </Link>
              </Button>
              <MenuAction
                icon={Zap}
                label="Engine Host"
                onClick={() => {
                  setDrawer(false);
                  setDetail(engineDetail);
                }}
              />
              <Button asChild variant="ghost" className="w-full justify-start">
                <Link to="/audit">
                  <Activity />
                  Audit
                </Link>
              </Button>
              <MenuAction
                icon={SlidersHorizontal}
                label="Mode & Simulasi"
                onClick={() => accessory("Mode & Simulasi")}
              />
              <MenuAction icon={Activity} label="Alert" onClick={() => accessory("Alert")} />
            </MenuGroup>
            <MenuGroup title="Bantuan">
              <Button asChild variant="ghost" className="w-full justify-start">
                <Link to="/assistant">
                  <BookOpen />
                  Knowledge Base
                </Link>
              </Button>
            </MenuGroup>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={detail !== null}
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
      >
        <DialogContent className="max-w-[calc(100vw-32px)]">
          <DialogTitle>Detail sistem</DialogTitle>
          <DialogDescription className="whitespace-pre-wrap break-words">
            {detail}
          </DialogDescription>
        </DialogContent>
      </Dialog>
      <RobotBubble hasAlerts={hasAlerts} />
    </>
  );
}
function MenuGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mobile-label mb-1">{title}</h3>
      {children}
    </section>
  );
}
function MenuAction({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Menu;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button variant="ghost" className="w-full justify-start" onClick={onClick}>
      <Icon />
      {label}
    </Button>
  );
}
function RobotBubble({ hasAlerts }: { hasAlerts: boolean }) {
  const navigate = useNavigate();
  const ref = useRef<HTMLButtonElement>(null);
  const drag = useRef<{
    x: number;
    y: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const [position, setPosition] = useState<{ side: "left" | "right"; y: number } | null>(null);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("mobile-assistant-position") ?? "null");
      if (saved && (saved.side === "left" || saved.side === "right") && typeof saved.y === "number")
        setPosition({
          side: saved.side,
          y: Math.max(80, Math.min(window.innerHeight - 190, saved.y)),
        });
    } catch {
      /* default anchor */
    }
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el || !position) return;
    el.style.left = position.side === "left" ? "12px" : "auto";
    el.style.right = position.side === "right" ? "12px" : "auto";
    el.style.top = `${position.y}px`;
    el.style.bottom = "auto";
  }, [position]);
  const down = (e: PointerEvent<HTMLButtonElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    drag.current = { x: box.x, y: box.y, startX: e.clientX, startY: e.clientY, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX,
      dy = e.clientY - d.startY;
    if (Math.abs(dx) + Math.abs(dy) > 8) d.moved = true;
    if (!d.moved) return;
    e.currentTarget.style.left = `${Math.max(8, Math.min(window.innerWidth - 64, d.x + dx))}px`;
    e.currentTarget.style.right = "auto";
    e.currentTarget.style.top = `${Math.max(80, Math.min(window.innerHeight - 190, d.y + dy))}px`;
    e.currentTarget.style.bottom = "auto";
  };
  const up = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) {
      void navigate({ to: "/assistant" });
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    const p = {
      side: r.x + r.width / 2 < window.innerWidth / 2 ? ("left" as const) : ("right" as const),
      y: Math.max(80, Math.min(window.innerHeight - 190, r.y)),
    };
    setPosition(p);
    try {
      localStorage.setItem("mobile-assistant-position", JSON.stringify(p));
    } catch {
      /* persistence optional */
    }
  };
  return (
    <Button
      ref={ref}
      variant="ghost"
      aria-label="Chat AI Assistant"
      className="mobile-robot-bubble"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void navigate({ to: "/assistant" });
        }
      }}
    >
      <img src={robot.url} alt="" draggable={false} />
      {hasAlerts && <span className="mobile-alert-dot" />}
    </Button>
  );
}

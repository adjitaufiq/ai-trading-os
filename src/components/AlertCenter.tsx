import { useState, useSyncExternalStore } from "react";
import { Bell, BellRing, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  alertHeadline, alertLevels, alertTitle, notifyPermission, requestNotify,
  type AlarmController, type NotificationApi, type NotifyPermission, type SignalAlertStore,
} from "@/lib/signalAlerts";

const ALARM_COPY = { OFF: "ALARM MATI", ACTIVE: "ALARM AKTIF", MUTED: "ALARM DIBISUKAN", NEEDS_REUNLOCK: "Alarm perlu diaktifkan ulang", UNAVAILABLE: "AUDIO TIDAK TERSEDIA" } as const;
const time = (ms: number) => new Date(ms).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function AlertCenter({ store, alarm, notificationApi, onSelect }: {
  store: SignalAlertStore; alarm: AlarmController; notificationApi: NotificationApi | null; onSelect: (symbol: string) => void;
}) {
  const alerts = useSyncExternalStore(store.subscribe, store.getAlerts, store.getAlerts);
  const alarmStatus = useSyncExternalStore(alarm.subscribe, alarm.status, alarm.status);
  const [perm, setPerm] = useState<NotifyPermission>(() => notifyPermission(notificationApi));
  const unread = alerts.filter((a) => !a.read).length;
  const activate = async () => {
    await alarm.enable();
    if (alarm.status() === "MUTED") alarm.setMuted(false);
    if (notifyPermission(notificationApi) === "NOT_SET") setPerm(await requestNotify(notificationApi));
  };
  return <Popover>
    <PopoverTrigger asChild>
      <Button size="sm" variant="ghost" aria-label={`Notifikasi sinyal, ${unread} belum dibaca`} className="relative ml-auto" data-testid="alert-bell">
        {unread ? <BellRing className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
        {unread > 0 && <span data-testid="alert-unread" className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">{unread > 99 ? "99+" : unread}</span>}
      </Button>
    </PopoverTrigger>
    <PopoverContent align="end" className="w-[min(92vw,380px)] p-0">
      <div className="space-y-2 border-b border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold uppercase" data-testid="alarm-status">{ALARM_COPY[alarmStatus]}</span>
          <div className="flex gap-1">
            {alarmStatus !== "ACTIVE" && alarmStatus !== "UNAVAILABLE" && <Button size="sm" onClick={activate} data-testid="alarm-enable">AKTIFKAN ALARM</Button>}
            {(alarmStatus === "ACTIVE" || alarmStatus === "MUTED") && <Button size="icon" variant="outline" className="h-8 w-8" aria-label={alarmStatus === "MUTED" ? "Nyalakan suara" : "Bisukan"} onClick={() => alarm.setMuted(alarmStatus !== "MUTED")}>
              {alarmStatus === "MUTED" ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}</Button>}
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">Notifikasi browser: <span data-testid="notify-perm" className="font-semibold text-foreground">{perm}</span> · Radar aktif selama halaman berjalan.</p>
      </div>
      <div className="max-h-[60vh] overflow-y-auto">
        {alerts.length === 0 ? <p className="p-4 text-sm text-muted-foreground">Belum ada sinyal baru sejak radar berjalan.</p>
          : alerts.map((a) => <button key={a.id} type="button" data-testid="alert-item" onClick={() => { store.markRead(a.id); onSelect(a.symbol); }}
            className={`block w-full border-b border-border px-3 py-2 text-left hover:bg-muted ${a.read ? "opacity-60" : ""}`}>
            <div className="flex items-center justify-between gap-2 text-xs font-semibold"><span>🚨 {alertTitle(a)}</span><span className="font-normal text-muted-foreground">{time(a.created_at)}</span></div>
            <div className={`text-sm font-bold ${a.side === "BUY" ? "text-bull" : "text-bear"}`}>{alertHeadline(a)}</div>
            <div className="font-mono text-[11px] text-muted-foreground">{alertLevels(a)}</div>
            <div className="truncate text-[11px] text-muted-foreground">{a.reason}</div>
          </button>)}
      </div>
      {alerts.length > 0 && <div className="flex justify-end gap-1 p-2">
        <Button size="sm" variant="ghost" onClick={() => store.markAllRead()}>Tandai dibaca</Button>
        <Button size="sm" variant="ghost" onClick={() => store.clearRead()}>Hapus yang dibaca</Button>
      </div>}
    </PopoverContent>
  </Popover>;
}

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/auth")({
  head: () => ({ meta: [
    { title: "Masuk — AI Trading Assistant" },
    { name: "description", content: "Masuk untuk menyimpan percakapan AI Trading Assistant lintas device." },
    { property: "og:title", content: "Masuk — AI Trading Assistant" },
    { property: "og:description", content: "Login untuk riwayat chat Trading OS yang persisten." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { if (data.session) navigate({ to: "/assistant" }); });
    const { data } = supabase.auth.onAuthStateChange((e, s) => { if (e === "SIGNED_IN" && s) navigate({ to: "/assistant" }); });
    return () => data.subscription.unsubscribe();
  }, [navigate]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setMsg(null);
    const r = mode === "in"
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password, options: { emailRedirectTo: `${window.location.origin}/auth` } });
    setBusy(false);
    if (r.error) setMsg(r.error.message);
    else if (mode === "up" && !r.data.session) setMsg("Cek email lo untuk konfirmasi akun.");
  };
  const google = async () => {
    const r = await lovable.auth.signInWithOAuth("google", { redirect_uri: window.location.origin + "/auth" });
    if (r.error) setMsg(String(r.error.message ?? r.error));
  };

  return <div className="flex min-h-screen items-center justify-center bg-background px-4">
    <div className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">AI Trading Assistant</h1>
        <p className="text-sm text-muted-foreground">{mode === "in" ? "Masuk untuk membuka riwayat chat." : "Buat akun baru."}</p>
      </div>
      <Button variant="outline" className="w-full" onClick={google}>Lanjut dengan Google</Button>
      <form onSubmit={submit} className="space-y-3">
        <Input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <Input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} />
        <Button type="submit" className="w-full" disabled={busy}>{mode === "in" ? "Masuk" : "Daftar"}</Button>
      </form>
      {msg ? <p className="text-sm text-warn" role="alert">{msg}</p> : null}
      <button className="text-xs text-muted-foreground underline" onClick={() => setMode(mode === "in" ? "up" : "in")}>
        {mode === "in" ? "Belum punya akun? Daftar" : "Sudah punya akun? Masuk"}
      </button>
    </div>
  </div>;
}

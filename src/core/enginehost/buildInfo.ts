// Runtime build identity for the engine host. Pure: values are injected (env or BUILD_INFO.json written by the
// deploy-zip script). Missing commit/build_time stay null — never guessed — so an old or hand-copied build is visible.
export const ENGINE_VERSION = "engine-host-v1.2" as const;

export interface EngineBuildInfo {
  readonly engine_version: string;
  readonly commit: string | null;
  readonly build_time: string | null;
  readonly status: "running";
}

const clean = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export function resolveBuildInfo(src: { commit?: unknown; build_time?: unknown } | null | undefined): EngineBuildInfo {
  return Object.freeze({ engine_version: ENGINE_VERSION, commit: clean(src?.commit), build_time: clean(src?.build_time), status: "running" as const });
}

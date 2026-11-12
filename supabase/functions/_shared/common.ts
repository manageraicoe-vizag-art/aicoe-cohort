// Shared helpers for every server function.
import { createClient } from "npm:@supabase/supabase-js@2";

export const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const ALLOWED = (Deno.env.get("ALLOWED_ORIGINS") ?? "*").split(",").map((s) => s.trim()).filter(Boolean);

export function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allow = ALLOWED.includes("*") ? "*" : ALLOWED.includes(origin) ? origin : ALLOWED[0] ?? "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), "Content-Type": "application/json" },
  });
}

/** A mistake the user can fix: shown to them as is. */
export class UserError extends Error {}

export function serve(handler: (req: Request, body: Record<string, any>) => Promise<unknown>) {
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
    if (req.method !== "POST") return json(req, { ok: false, error: "Use POST." }, 405);
    try {
      const body = await req.json().catch(() => ({}));
      const result = await handler(req, body ?? {});
      return json(req, { ok: true, ...(result as object) });
    } catch (e) {
      if (e instanceof UserError) return json(req, { ok: false, error: e.message }, 400);
      console.error(e);
      return json(req, { ok: false, error: "Something went wrong on our side. Please try again in a minute." }, 500);
    }
  });
}

export async function getSettings() {
  const { data, error } = await db.from("settings").select("*").eq("id", 1).single();
  if (error) throw error;
  return data;
}

export function siteUrl(settings: { site_url?: string | null }, req?: Request): string {
  const base = settings.site_url || Deno.env.get("SITE_URL") || req?.headers.get("origin") || "";
  if (!base) console.warn("No website address: set settings.site_url or the SITE_URL secret, or email links will be relative");
  return base.replace(/\/$/, "");
}

export function payLink(settings: { site_url?: string | null }, token: string, req?: Request): string {
  return `${siteUrl(settings, req)}/pay.html?t=${token}`;
}

/** Today's date in India, as YYYY-MM-DD. */
export function todayIST(): string {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

export async function audit(actor: string, action: string, target: string | null, detail: unknown = null) {
  await db.from("audit_log").insert({ actor, action, target, detail });
}

/** Trimmed text with control characters (line breaks, tabs, carriage returns) replaced by spaces. */
export const str = (v: unknown, max = 200): string =>
  typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";

export const RATINGS = ["coding", "data", "ui", "writing", "presenting", "github_comfort"] as const;

/** Text that a spreadsheet might read as a formula loses its leading = + - @. */
export const safeText = (s: string): string => s.replace(/^[=+\-@]+/, "");

export async function verifyTurnstile(token: string, ip: string | null): Promise<boolean> {
  const secret = Deno.env.get("TURNSTILE_SECRET");
  if (!secret) return Deno.env.get("ALLOW_NO_CAPTCHA") === "1"; // only skipped when explicitly allowed (testing)
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const d = await r.json();
  return Boolean(d.success);
}

export const PROOF_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "application/pdf": "pdf" };
export const MAX_PROOF_BYTES = 2 * 1024 * 1024;

export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

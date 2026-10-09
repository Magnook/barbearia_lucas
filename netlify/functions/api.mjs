import { getStore } from "@netlify/blobs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const config = { path: "/api/*" };

const TZ = "America/Recife";
const bookings = () => getStore({ name: "bookings", consistency: "strong" });
const limits = () => getStore({ name: "limits", consistency: "strong" });
const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const dig = (s) => String(s || "").replace(/\D/g, "");
const phoneOf = (s) => { let d = dig(s); if (d.length > 11 && d.startsWith("55")) d = d.slice(2); return d; };
const fmtPhone = (d) => d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
const hhmm = (m) => String(Math.floor(m / 60)).padStart(2, "0") + String(m % 60).padStart(2, "0");
const keyOf = (d, m) => `${d}_${hhmm(m)}`;
const hash = (salt, code) => createHash("sha256").update(`${salt}:${code}`).digest("hex");
const sha = (s) => createHash("sha256").update(s).digest();
const ID_RE = /^\d{4}-\d{2}-\d{2}_\d{4}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function now() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date()).map((x) => [x.type, x.value])
  );
  return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
}

// Regras da barbearia: segunda = folga; domingo até 13:00; 08:00–20:00; almoço 12:00–13:00; intervalos de 30 min
function validSlot(date, min) {
  if (!DATE_RE.test(date) || !Number.isInteger(min)) return false;
  const t = new Date(date + "T12:00:00Z");
  if (isNaN(t)) return false;
  const dw = t.getUTCDay();
  if (dw === 1) return false;
  const end = (dw === 0 ? 13 : 20) * 60;
  return min >= 480 && min < end && min % 30 === 0 && !(min >= 720 && min < 780);
}

// Limite de tentativas por IP/hora (guarda contadores no Blobs)
const lkey = (ip, kind) => { const n = now(); return `${kind}_${ip.replace(/[^\w.:-]/g, "_")}_${n.date}_${Math.floor(n.min / 60)}`; };
async function blocked(ip, kind, max) { const v = await limits().get(lkey(ip, kind), { type: "json" }); return (v?.n || 0) >= max; }
async function bump(ip, kind) { const k = lkey(ip, kind); const v = await limits().get(k, { type: "json" }); await limits().setJSON(k, { n: (v?.n || 0) + 1 }); }

// Senha do barbeiro = variável de ambiente BARBER_KEY
async function barber(req, ip) {
  const sent = req.headers.get("x-barber-key") || "";
  if (!sent) return "no";
  if (await blocked(ip, "key", 10)) return "limited";
  const k = process.env.BARBER_KEY || "";
  if (k && timingSafeEqual(sha(k), sha(sent))) return "ok";
  await bump(ip, "key");
  return "no";
}

export default async (req, context) => {
  const route = new URL(req.url).pathname.replace(/^\/api\/?/, "");
  const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || "unknown";
  try {
    // Público: só quais horários estão ocupados (sem nomes/telefones)
    if (route === "slots" && req.method === "GET") {
      const date = new URL(req.url).searchParams.get("date") || "";
      if (!DATE_RE.test(date)) return json({ error: "Data inválida" }, 400);
      const { blobs } = await bookings().list({ prefix: date + "_" });
      const taken = blobs.map((b) => { const h = b.key.slice(11); return +h.slice(0, 2) * 60 + +h.slice(2); });
      return json({ taken });
    }

    // Barbeiro: agenda completa do dia
    if (route === "agenda" && req.method === "GET") {
      const g = await barber(req, ip);
      if (g === "limited") return json({ error: "Muitas tentativas. Tente mais tarde." }, 429);
      if (g !== "ok") return json({ error: "Senha incorreta" }, 401);
      const date = new URL(req.url).searchParams.get("date") || "";
      if (!DATE_RE.test(date)) return json({ error: "Data inválida" }, 400);
      const { blobs } = await bookings().list({ prefix: date + "_" });
      const items = [];
      for (const b of blobs) {
        const r = await bookings().get(b.key, { type: "json" });
        if (r) items.push({ date: r.date, min: r.min, name: r.name, phone: fmtPhone(r.phone) });
      }
      return json({ items });
    }

    // Cliente: criar agendamento
    if (route === "book" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const name = String(b.name || "").trim().slice(0, 40);
      const phone = phoneOf(b.phone);
      const code = String(b.code || "");
      const { date, min } = b;
      if (name.length < 2 || phone.length < 10 || phone.length > 11 || !/^\d{4}$/.test(code)) return json({ error: "Dados inválidos" }, 400);
      if (!validSlot(date, min)) return json({ error: "Horário inválido" }, 400);
      const n = now();
      if (date < n.date || (date === n.date && min <= n.min)) return json({ error: "Esse horário já passou" }, 400);
      if (date > new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10)) return json({ error: "Data muito distante" }, 400);
      if (await blocked(ip, "book", 12)) return json({ error: "Muitas tentativas. Tente mais tarde." }, 429);
      await bump(ip, "book");
      const key = keyOf(date, min);
      if (await bookings().get(key)) return json({ error: "conflict" }, 409);
      const salt = randomBytes(8).toString("hex");
      const res = await bookings().set(key, JSON.stringify({ name, phone, date, min, salt, ch: hash(salt, code), ts: Date.now() }), { onlyIfNew: true });
      if (res && res.modified === false) return json({ error: "conflict" }, 409);
      return json({ ok: true });
    }

    // Cliente: achar seus agendamentos futuros com WhatsApp + código
    if (route === "find" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const phone = phoneOf(b.phone), code = String(b.code || "");
      if (phone.length < 10 || !/^\d{4}$/.test(code)) return json({ error: "Dados inválidos" }, 400);
      if (await blocked(ip, "fail", 10)) return json({ error: "Muitas tentativas. Tente mais tarde." }, 429);
      const today = now().date;
      const { blobs } = await bookings().list();
      const items = [];
      for (const { key } of blobs) {
        if (key.slice(0, 10) < today) continue;
        const r = await bookings().get(key, { type: "json" });
        if (r && r.phone === phone && hash(r.salt, code) === r.ch) items.push({ id: key, date: r.date, min: r.min });
      }
      if (!items.length) await bump(ip, "fail");
      return json({ items });
    }

    // Cancelar: cliente (com código) ou barbeiro (com senha)
    if (route === "cancel" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const id = String(b.id || "");
      if (!ID_RE.test(id)) return json({ error: "Dados inválidos" }, 400);
      const g = await barber(req, ip);
      if (g === "limited") return json({ error: "Muitas tentativas. Tente mais tarde." }, 429);
      if (g !== "ok") {
        if (await blocked(ip, "fail", 10)) return json({ error: "Muitas tentativas. Tente mais tarde." }, 429);
        const r = await bookings().get(id, { type: "json" });
        if (!r) return json({ error: "Agendamento não encontrado" }, 404);
        if (hash(r.salt, String(b.code || "")) !== r.ch) { await bump(ip, "fail"); return json({ error: "Código incorreto" }, 403); }
      }
      await bookings().delete(id);
      return json({ ok: true });
    }
  } catch (e) {
    console.error(e);
    return json({ error: "Erro no servidor" }, 500);
  }
  return json({ error: "Não encontrado" }, 404);
};

import { getStore } from "@netlify/blobs";

// ملف إكسل التقرير الأسبوعي (منفصل عن التقرير الشهري /api/monthly-data)
export const config = { path: "/api/dashboard-data" };

const KEY = "latest.xlsx";
const noCache = { "Cache-Control": "no-store" };
const json = (obj, status) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...noCache } });

export default async (req) => {
  const store = getStore({ name: "dashboard-weekly", consistency: "strong" });
  const url = new URL(req.url);

  // قراءة: أي شخص يفتح الرابط
  if (req.method === "GET") {
    // ?meta=1 ← وقت آخر تحديث فقط (خفيف، تستعمله اللوحة كل بضع ثوانٍ)
    if (url.searchParams.get("meta")) {
      const meta = await store.getMetadata(KEY);
      if (!meta) return json({ error: "no data yet" }, 404);
      return json({ updatedAt: meta.metadata?.updatedAt || "" }, 200);
    }
    const found = await store.getWithMetadata(KEY, { type: "arrayBuffer" });
    if (!found) return json({ error: "no data yet" }, 404);
    return new Response(found.data, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Updated-At": String(found.metadata?.updatedAt || ""),
        ...noCache,
      },
    });
  }

  // رفع: بدون كلمة مرور
  if (req.method === "POST") {
    const buf = await req.arrayBuffer();
    if (buf.byteLength < 1000 || buf.byteLength > 15 * 1024 * 1024) return json({ error: "حجم الملف غير مناسب" }, 400);
    const head = new Uint8Array(buf, 0, 2);
    if (head[0] !== 0x50 || head[1] !== 0x4b) return json({ error: "الملف ليس إكسل صالحًا" }, 400);

    const updatedAt = new Date().toISOString();
    await store.set(KEY, buf, {
      metadata: { updatedAt, fileName: decodeURIComponent(req.headers.get("x-file-name") || "") },
    });
    return json({ ok: true, updatedAt }, 200);
  }

  return json({ error: "method not allowed" }, 405);
};

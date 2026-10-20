import { getStore } from "@netlify/blobs";

export const config = { path: "/api/dashboard-data" };

const KEY = "latest.xlsx";
const noCache = { "Cache-Control": "no-store" };
const json = (obj, status) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...noCache } });

export default async (req) => {
  const store = getStore({ name: "dashboard", consistency: "strong" });

  // قراءة: أي شخص يفتح الرابط
  if (req.method === "GET") {
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

  // رفع: بكلمة مرور فقط
  if (req.method === "POST") {
    const pw = process.env.UPLOAD_PASSWORD;
    if (!pw) return json({ error: "UPLOAD_PASSWORD غير مضبوط في Netlify" }, 500);
    if (req.headers.get("x-upload-password") !== pw) return json({ error: "كلمة المرور غير صحيحة" }, 401);

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

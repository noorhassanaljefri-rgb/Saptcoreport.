// خادم Railway: يعرض اللوحة (مجلد public) ويحفظ آخر ملف إكسل ليظهر لكل من يفتح الرابط.
// بدون أي مكتبات خارجية — Node 18+ فقط.
//   /api/dashboard-data  ← التقرير الأسبوعي
//   /api/monthly-data    ← التقرير الشهري
// الملفات تُحفظ في DATA_DIR (اربطي Volume في Railway على المسار /data حتى لا تضيع عند إعادة النشر).

const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync("/data") ? "/data" : path.join(__dirname, "data"));
const MAX_BYTES = 15 * 1024 * 1024;

const STORES = { "/api/dashboard-data": "weekly", "/api/monthly-data": "monthly" };

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".ico": "image/x-icon",
  ".webp": "image/webp", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

const noCache = { "Cache-Control": "no-store" };
function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...noCache });
  res.end(JSON.stringify(obj));
}

const fileOf = (name) => path.join(DATA_DIR, name + ".xlsx");
const metaOf = (name) => path.join(DATA_DIR, name + ".json");
async function readMeta(name) {
  try { return JSON.parse(await fsp.readFile(metaOf(name), "utf8")); } catch { return null; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BYTES) { reject(Object.assign(new Error("too big"), { status: 400 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleApi(req, res, name, url) {
  if (req.method === "GET") {
    const meta = await readMeta(name);
    if (!meta) return sendJson(res, 404, { error: "no data yet" });
    // ?meta=1 ← وقت آخر تحديث فقط (خفيف، تستعمله اللوحة كل بضع ثوانٍ)
    if (url.searchParams.get("meta")) return sendJson(res, 200, { updatedAt: meta.updatedAt || "" });
    let buf;
    try { buf = await fsp.readFile(fileOf(name)); } catch { return sendJson(res, 404, { error: "no data yet" }); }
    res.writeHead(200, { "Content-Type": "application/octet-stream", "X-Updated-At": String(meta.updatedAt || ""), ...noCache });
    return res.end(buf);
  }

  if (req.method === "POST") {
    let buf;
    try { buf = await readBody(req); } catch { return sendJson(res, 400, { error: "حجم الملف غير مناسب" }); }
    if (buf.length < 1000) return sendJson(res, 400, { error: "حجم الملف غير مناسب" });
    if (buf[0] !== 0x50 || buf[1] !== 0x4b) return sendJson(res, 400, { error: "الملف ليس إكسل صالحًا" });
    const updatedAt = new Date().toISOString();
    let fileName = "";
    try { fileName = decodeURIComponent(req.headers["x-file-name"] || ""); } catch {}
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmp = fileOf(name) + ".tmp";
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, fileOf(name));              // كتابة كاملة ثم استبدال — لا يُقرأ ملف نصف مكتوب
    await fsp.writeFile(metaOf(name), JSON.stringify({ updatedAt, fileName }));
    return sendJson(res, 200, { ok: true, updatedAt });
  }

  return sendJson(res, 405, { error: "method not allowed" });
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  try {
    const st = await fsp.stat(full);
    if (st.isDirectory()) return serveStatic(req, res, new URL(url.pathname.replace(/\/?$/, "/"), url));
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", ...(ext === ".html" ? noCache : {}) });
    fs.createReadStream(full).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const store = STORES[url.pathname.replace(/\/$/, "")];
    if (store) return await handleApi(req, res, store, url);
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
    return await serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: "server error" });
    else res.end();
  }
}).listen(PORT, () => {
  console.log(`SAPTCO dashboard on :${PORT} — data dir: ${DATA_DIR}`);
});

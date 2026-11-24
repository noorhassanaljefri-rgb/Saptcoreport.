// خادم Railway: يعرض اللوحة (مجلد public) ويحفظ آخر ملف إكسل ليظهر لكل من يفتح الرابط.
// بدون أي مكتبات خارجية — Node 18+ فقط.
//   /api/dashboard-data  ← التقرير الأسبوعي
//   /api/monthly-data    ← التقرير الشهري
//   /api/services-media  ← فيديوهات/صور قسم «الخدمات» (قائمة، رفع، عرض، حذف)
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

// رابط GitHub Pages يقرأ ويرفع إلى هذا الخادم نفسه → نسمح له فقط (CORS)
const ALLOWED_ORIGIN = /^https:\/\/noorhassanaljefri-rgb\.github\.io$/i;
function cors(req, res) {
  const o = req.headers.origin;
  if (!o || !ALLOWED_ORIGIN.test(o)) return;
  res.setHeader("Access-Control-Allow-Origin", o);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "x-upload-password, x-file-name, content-type, range");
  res.setHeader("Access-Control-Expose-Headers", "X-Updated-At, Content-Range, Accept-Ranges");
  res.setHeader("Access-Control-Max-Age", "600");
}
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

// ---------- وسائط قسم «الخدمات» ----------
const MEDIA_DIR = path.join(DATA_DIR, "media");
const MEDIA_LIST = path.join(MEDIA_DIR, "list.json");
const MEDIA_MAX = 200 * 1024 * 1024;
const MEDIA_TYPES = { "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov", "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" };
const EXT_TYPE = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };
async function readMediaList() { try { return JSON.parse(await fsp.readFile(MEDIA_LIST, "utf8")); } catch { return []; } }
async function writeMediaList(list) { await fsp.mkdir(MEDIA_DIR, { recursive: true }); const t = MEDIA_LIST + ".tmp"; await fsp.writeFile(t, JSON.stringify(list)); await fsp.rename(t, MEDIA_LIST); }
function sniffType(buf) {
  if (buf.length > 12 && buf.toString("latin1", 4, 8) === "ftyp") return buf.toString("latin1", 8, 10) === "qt" ? "video/quicktime" : "video/mp4";
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "video/webm";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf.toString("latin1", 1, 4) === "PNG") return "image/png";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (buf.toString("latin1", 0, 3) === "GIF") return "image/gif";
  return null;
}
function readMediaBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > MEDIA_MAX) { reject(new Error("too big")); req.destroy(); return; } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function handleMedia(req, res, url, sub) {
  if (sub) {   // /api/services-media/<file> ← ملف واحد (يدعم Range لتشغيل الفيديو والتقديم)
    if (!/^[a-z0-9]+\.[a-z0-9]+$/i.test(sub)) return sendJson(res, 404, { error: "not found" });
    const full = path.join(MEDIA_DIR, sub);
    let st; try { st = await fsp.stat(full); } catch { return sendJson(res, 404, { error: "not found" }); }
    const type = EXT_TYPE[path.extname(sub).toLowerCase()] || "application/octet-stream";
    const head = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=31536000, immutable" };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (m && (m[1] || m[2])) {
      let start = m[1] ? parseInt(m[1], 10) : st.size - parseInt(m[2], 10);
      let end = m[1] && m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (start < 0) start = 0; if (end >= st.size) end = st.size - 1;
      if (start > end) { res.writeHead(416, { "Content-Range": `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...head, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": end - start + 1 });
      if (req.method === "HEAD") return res.end();
      return fs.createReadStream(full, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...head, "Content-Length": st.size });
    if (req.method === "HEAD") return res.end();
    return fs.createReadStream(full).pipe(res);
  }
  if (req.method === "GET" || req.method === "HEAD") return sendJson(res, 200, { items: await readMediaList() });
  if (req.method === "POST") {
    const del = url.searchParams.get("delete");
    if (del) {   // حذف عنصر
      const list = await readMediaList(); const it = list.find((x) => x.id === del);
      if (!it) return sendJson(res, 404, { error: "not found" });
      await writeMediaList(list.filter((x) => x.id !== del));
      try { await fsp.unlink(path.join(MEDIA_DIR, it.file)); } catch {}
      return sendJson(res, 200, { ok: true });
    }
    let buf; try { buf = await readMediaBody(req); } catch { return sendJson(res, 400, { error: "الحجم أكبر من 200 ميجا" }); }
    const type = sniffType(buf);
    if (!type || !MEDIA_TYPES[type]) return sendJson(res, 400, { error: "الملف ليس فيديو أو صورة مدعومة (mp4 / webm / mov / jpg / png)" });
    let name = ""; try { name = decodeURIComponent(req.headers["x-file-name"] || url.searchParams.get("name") || ""); } catch {}
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const file = id + MEDIA_TYPES[type];
    await fsp.mkdir(MEDIA_DIR, { recursive: true });
    await fsp.writeFile(path.join(MEDIA_DIR, file + ".tmp"), buf);
    await fsp.rename(path.join(MEDIA_DIR, file + ".tmp"), path.join(MEDIA_DIR, file));
    const item = { id, file, type, name: name.slice(0, 200), size: buf.length, addedAt: new Date().toISOString() };
    const list = await readMediaList(); list.push(item); await writeMediaList(list);
    return sendJson(res, 200, { ok: true, item });
  }
  return sendJson(res, 405, { error: "method not allowed" });
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
    const mm = /^\/api\/services-media(?:\/([^/]+))?\/?$/.exec(url.pathname);
    if (mm) {
      cors(req, res);
      if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
      return await handleMedia(req, res, url, mm[1]);
    }
    const store = STORES[url.pathname.replace(/\/$/, "")];
    if (store) {
      cors(req, res);
      if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
      return await handleApi(req, res, store, url);
    }
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

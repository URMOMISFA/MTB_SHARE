const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const MAX_BODY = Number(process.env.MAX_UPLOAD_MB || 60) * 1024 * 1024;

// ── Cloudflare R2 config ─────────────────────────────────────────────────────
// Set these environment variables in your host (Render, Railway, etc.):
//   R2_ACCOUNT_ID   – Cloudflare account ID (from R2 dashboard)
//   R2_ACCESS_KEY   – R2 access key ID
//   R2_SECRET_KEY   – R2 secret access key
//   R2_BUCKET       – bucket name (e.g. "mtb-share")
//   R2_PUBLIC_URL   – public bucket URL (e.g. "https://pub-xxx.r2.dev") OR your custom domain
//                     Leave blank to serve uploads through this server instead.
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "";
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY || "";
const R2_SECRET_KEY = process.env.R2_SECRET_KEY || "";
const R2_BUCKET     = process.env.R2_BUCKET || "";
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || "").replace(/\/$/, "");
const R2_ENDPOINT   = R2_ACCOUNT_ID
  ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
  : "";
const USE_R2 = !!(R2_ACCOUNT_ID && R2_ACCESS_KEY && R2_SECRET_KEY && R2_BUCKET);

// ── AWS Signature V4 (no SDK needed) ────────────────────────────────────────
function hmacSha256(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function getSigningKey(secretKey, dateStamp, region, service) {
  const kDate    = hmacSha256(`AWS4${secretKey}`, dateStamp);
  const kRegion  = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

async function r2PutObject(key, buffer, contentType) {
  const region  = "auto";
  const service = "s3";
  const host    = `${R2_BUCKET}.${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const now     = new Date();
  const amzDate    = now.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15) + "Z";
  const dateStamp  = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(buffer);

  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders    = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    "PUT",
    `/${key}`,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = getSigningKey(R2_SECRET_KEY, dateStamp, region, service);
  const signature  = hmacSha256(signingKey, stringToSign).toString("hex");
  const authHeader = `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host,
      path: `/${key}`,
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "Content-Length": buffer.length,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
        "Authorization": authHeader,
      },
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`R2 upload failed (${res.statusCode}): ${body}`));
        }
      });
    });
    req.on("error", reject);
    req.write(buffer);
    req.end();
  });
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

function seedDatabase() {
  return {
    users: [
      createSeedUser("avery", "Avery Kim", "AK", "blue", "Trail rider. Tempo laps and clean route beta."),
      createSeedUser("maya", "Maya Reed", "MR", "green", "Trail reporter. Dirt conditions, closures, and stewardship."),
      createSeedUser("cam", "Cam Torres", "CT", "amber", "No-drop rides, gravity days, and tech loops."),
    ],
    sessions: [],
    posts: [],
    videos: [],
    clubs: [
      { id: "club-after-work", name: "After Work Dirt", kind: "Crew", members: ["user-avery"], description: "Tuesday tempo laps and weekend shuttle days." },
      { id: "club-no-drop", name: "No Drop Gravity", kind: "Crew", members: ["user-cam"], description: "Beginner friendly park laps, skills nights, and bike checks." },
      { id: "club-stewards", name: "Quarry Ridge Stewards", kind: "Build", members: ["user-maya"], description: "Trail days, closure alerts, and maintenance plans." },
    ],
  };
}

function createSeedUser(handle, name, initials, avatar, bio) {
  return {
    id: `user-${handle}`,
    handle,
    name,
    initials,
    avatar,
    bio,
    password: "",
    stats: { miles: 128, rides: 14 },
    createdAt: Date.now(),
  };
}

function ensureDatabase() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!USE_R2) fs.mkdirSync(path.join(__dirname, "uploads"), { recursive: true });
  if (!fs.existsSync(DB_FILE)) writeDb(seedDatabase());
}

function readDb() {
  ensureDatabase();
  const db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  return migrateDb(db);
}

function writeDb(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function migrateDb(db) {
  let changed = false;
  const fakePostIds = new Set(["post-ak-1", "post-mr-1", "post-ct-1"]);
  const fakeVideoIds = new Set(["video-ak-drop", "video-mr-report", "video-ct-rock"]);
  if (Array.isArray(db.posts)) {
    const posts = db.posts.filter((post) => !fakePostIds.has(post.id));
    if (posts.length !== db.posts.length) {
      db.posts = posts;
      changed = true;
    }
  } else {
    db.posts = [];
    changed = true;
  }
  if (!Array.isArray(db.videos)) {
    db.videos = [];
    changed = true;
  }
  const videos = db.videos.filter((video) => !fakeVideoIds.has(video.id));
  if (videos.length !== db.videos.length) {
    db.videos = videos;
    changed = true;
  }
  db.videos.forEach((video, index) => {
    if (!Array.isArray(video.likes)) {
      video.likes = [];
      changed = true;
    }
    if (typeof video.views !== "number") {
      video.views = 0;
      changed = true;
    }
    if (!video.palette) {
      video.palette = ["green", "amber", "blue"][index % 3];
      changed = true;
    }
  });
  if (changed) writeDb(db);
  return db;
}

function sendJson(response, status, payload, extraHeaders = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        reject(new Error("Body too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    request.on("error", reject);
  });
}

function getCookie(request, name) {
  const cookies = request.headers.cookie || "";
  return cookies
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function getSessionUser(request, db) {
  const token = getCookie(request, "mtb_session");
  if (!token) return null;
  const session = db.sessions.find((item) => item.token === token && item.expiresAt > Date.now());
  if (!session) return null;
  return db.users.find((user) => user.id === session.userId) || null;
}

function requireUser(request, response, db) {
  const user = getSessionUser(request, db);
  if (!user) {
    sendJson(response, 401, { error: "Sign in required" });
    return null;
  }
  return user;
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    handle: user.handle,
    name: user.name,
    initials: user.initials,
    avatar: user.avatar,
    bio: user.bio,
    stats: user.stats,
  };
}

function hydratePost(post, db, viewer) {
  const author = db.users.find((user) => user.id === post.userId);
  return {
    ...post,
    author: publicUser(author),
    reactionCount: post.reactions.length,
    commentCount: post.comments.length,
    rideRequestCount: post.rideRequests.length,
    reacted: viewer ? post.reactions.includes(viewer.id) : false,
    requested: viewer ? post.rideRequests.includes(viewer.id) : false,
    comments: post.comments.map((comment) => ({
      ...comment,
      author: publicUser(db.users.find((user) => user.id === comment.userId)),
    })),
  };
}

function hydrateVideo(video, db, viewer) {
  const author = db.users.find((user) => user.id === video.userId);
  return {
    ...video,
    author: publicUser(author),
    likeCount: video.likes.length,
    liked: viewer ? video.likes.includes(viewer.id) : false,
  };
}

function creatorAnalytics(db, viewer) {
  const ownerId = viewer ? viewer.id : "user-avery";
  const ownedVideos = db.videos.filter((video) => video.userId === ownerId);
  const sourceVideos = ownedVideos.length ? ownedVideos : db.videos;
  const totals = sourceVideos.reduce(
    (acc, video) => {
      acc.views += video.views;
      acc.likes += video.likes.length;
      return acc;
    },
    { views: 0, likes: 0 },
  );
  return {
    scope: viewer ? "Your videos" : "All creator videos",
    totals: {
      videos: sourceVideos.length,
      views: totals.views,
      likes: totals.likes,
      engagementRate: totals.views ? Math.round((totals.likes / totals.views) * 1000) / 10 : 0,
    },
    videos: sourceVideos
      .slice()
      .sort((a, b) => b.views - a.views)
      .map((video) => ({
        id: video.id,
        title: video.title,
        trail: video.trail,
        views: video.views,
        likes: video.likes.length,
        engagementRate: video.views ? Math.round((video.likes.length / video.views) * 1000) / 10 : 0,
      })),
  };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const check = hashPassword(password, salt).split(":")[1];
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(check));
}

function normalizeHandle(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 24);
}

function cleanText(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

async function saveUploadedMedia(media, userId) {
  if (!media || !media.dataUrl) return null;
  const match = String(media.dataUrl).match(/^data:([^;]+);base64,([a-zA-Z0-9+/=]+)$/);
  if (!match) throw new Error("Invalid upload data");
  const mime = match[1].toLowerCase();
  const allowed = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
  };
  const extension = allowed[mime];
  if (!extension) throw new Error("Upload must be a photo or video");
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length > MAX_BODY) throw new Error("Upload is too large");
  const kind = mime.startsWith("video/") ? "video" : "photo";
  const id = crypto.randomUUID();
  const filename = `${Date.now()}-${userId}-${id}${extension}`;

  let url;
  if (USE_R2) {
    const key = `uploads/${filename}`;
    await r2PutObject(key, buffer, mime);
    // Use public R2 URL if set, otherwise proxy through this server
    url = R2_PUBLIC_URL ? `${R2_PUBLIC_URL}/${key}` : `/uploads/${filename}`;
  } else {
    const uploadDir = path.join(__dirname, "uploads");
    fs.mkdirSync(uploadDir, { recursive: true });
    fs.writeFileSync(path.join(uploadDir, filename), buffer);
    url = `/uploads/${filename}`;
  }

  return {
    id,
    kind,
    mime,
    filename: cleanText(media.name, 120),
    url,
    size: buffer.length,
    r2: USE_R2,
  };
}

function makeSession(response, db, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  db.sessions = db.sessions.filter((session) => session.expiresAt > Date.now());
  db.sessions.push({ token, userId, expiresAt: Date.now() + SESSION_TTL_MS });
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader("Set-Cookie", `mtb_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`);
}

function clearSession(response) {
  response.setHeader("Set-Cookie", "mtb_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

async function handleApi(request, response, url) {
  const db = readDb();
  const user = getSessionUser(request, db);

  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      return sendJson(response, 200, { ok: true });
    }

    if (request.method === "GET" && url.pathname === "/api/me") {
      return sendJson(response, 200, { user: publicUser(user) });
    }

    if (request.method === "POST" && url.pathname === "/api/auth/signup") {
      const body = await readBody(request);
      const handle = normalizeHandle(body.handle);
      const name = cleanText(body.name, 60);
      const password = String(body.password || "");
      if (handle.length < 3 || name.length < 2 || password.length < 6) {
        return sendJson(response, 400, { error: "Use a 3+ character handle, name, and 6+ character password" });
      }
      if (db.users.some((item) => item.handle === handle)) {
        return sendJson(response, 409, { error: "That handle is already taken" });
      }
      const newUser = {
        id: `user-${crypto.randomUUID()}`,
        handle,
        name,
        initials: name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase(),
        avatar: ["blue", "green", "amber"][db.users.length % 3],
        bio: "Mountain bike rider on MTB Share.",
        password: hashPassword(password),
        stats: { miles: 0, rides: 0 },
        createdAt: Date.now(),
      };
      db.users.push(newUser);
      makeSession(response, db, newUser.id);
      writeDb(db);
      return sendJson(response, 201, { user: publicUser(newUser) });
    }

    if (request.method === "POST" && url.pathname === "/api/auth/login") {
      const body = await readBody(request);
      const handle = normalizeHandle(body.handle);
      const found = db.users.find((item) => item.handle === handle);
      if (!found || !verifyPassword(String(body.password || ""), found.password)) {
        return sendJson(response, 401, { error: "Invalid handle or password" });
      }
      makeSession(response, db, found.id);
      writeDb(db);
      return sendJson(response, 200, { user: publicUser(found) });
    }

    if (request.method === "POST" && url.pathname === "/api/auth/logout") {
      const token = getCookie(request, "mtb_session");
      const nextDb = readDb();
      nextDb.sessions = nextDb.sessions.filter((session) => session.token !== token);
      writeDb(nextDb);
      clearSession(response);
      return sendJson(response, 200, { ok: true });
    }

    if (request.method === "GET" && url.pathname === "/api/posts") {
      const filter = url.searchParams.get("type");
      const posts = db.posts
        .filter((post) => !filter || filter === "all" || post.type === filter)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((post) => hydratePost(post, db, user));
      return sendJson(response, 200, { posts });
    }

    if (request.method === "GET" && url.pathname === "/api/videos") {
      const videos = db.videos
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((video) => hydrateVideo(video, db, user));
      return sendJson(response, 200, { videos });
    }

    if (request.method === "GET" && url.pathname === "/api/analytics") {
      return sendJson(response, 200, { analytics: creatorAnalytics(db, user) });
    }

    const videoAction = url.pathname.match(/^\/api\/videos\/([^/]+)\/(view|like)$/);
    if (videoAction) {
      const video = db.videos.find((item) => item.id === videoAction[1]);
      if (!video) return sendJson(response, 404, { error: "Video not found" });

      if (request.method === "POST" && videoAction[2] === "view") {
        video.views += 1;
        writeDb(db);
        return sendJson(response, 200, { video: hydrateVideo(video, db, user) });
      }

      if (request.method === "POST" && videoAction[2] === "like") {
        const currentUser = requireUser(request, response, db);
        if (!currentUser) return;
        if (video.likes.includes(currentUser.id)) {
          video.likes = video.likes.filter((id) => id !== currentUser.id);
        } else {
          video.likes.push(currentUser.id);
        }
        writeDb(db);
        return sendJson(response, 200, { video: hydrateVideo(video, db, currentUser) });
      }
    }

    if (request.method === "POST" && url.pathname === "/api/posts") {
      const currentUser = requireUser(request, response, db);
      if (!currentUser) return;
      const body = await readBody(request);
      const text = cleanText(body.text, 700);
      if (text.length < 2) return sendJson(response, 400, { error: "Post text is required" });
      const type = ["ride", "report", "route", "video"].includes(body.type) ? body.type : "ride";
      const media = await saveUploadedMedia(body.media, currentUser.id);
      const post = {
        id: `post-${crypto.randomUUID()}`,
        userId: currentUser.id,
        type,
        trail: cleanText(body.trail, 80) || "Local trail",
        pace: cleanText(body.pace, 40) || "Social",
        text,
        route: type === "report" ? "" : cleanText(body.route, 60) || "Local share",
        hero: false,
        media,
        createdAt: Date.now(),
        reactions: [],
        comments: [],
        rideRequests: [],
      };
      db.posts.push(post);
      if (media && media.kind === "video") {
        db.videos.push({
          id: `video-${crypto.randomUUID()}`,
          userId: currentUser.id,
          postId: post.id,
          title: cleanText(body.title, 80) || cleanText(body.trail, 80) || "Rider upload",
          description: text,
          trail: cleanText(body.trail, 80) || "Local trail",
          duration: cleanText(body.duration, 20) || "Uploaded",
          views: 0,
          likes: [],
          createdAt: post.createdAt,
          palette: ["green", "amber", "blue"][db.videos.length % 3],
          media,
        });
      }
      currentUser.stats.rides += type === "ride" ? 1 : 0;
      writeDb(db);
      return sendJson(response, 201, { post: hydratePost(post, db, currentUser) });
    }

    const postAction = url.pathname.match(/^\/api\/posts\/([^/]+)\/(react|comments|request)$/);
    if (postAction) {
      const currentUser = requireUser(request, response, db);
      if (!currentUser) return;
      const post = db.posts.find((item) => item.id === postAction[1]);
      if (!post) return sendJson(response, 404, { error: "Post not found" });
      const action = postAction[2];

      if (request.method === "POST" && action === "react") {
        if (post.reactions.includes(currentUser.id)) {
          post.reactions = post.reactions.filter((id) => id !== currentUser.id);
        } else {
          post.reactions.push(currentUser.id);
        }
        writeDb(db);
        return sendJson(response, 200, { post: hydratePost(post, db, currentUser) });
      }

      if (request.method === "POST" && action === "comments") {
        const body = await readBody(request);
        const text = cleanText(body.text, 260);
        if (!text) return sendJson(response, 400, { error: "Comment text is required" });
        post.comments.push({ id: `comment-${crypto.randomUUID()}`, userId: currentUser.id, text, createdAt: Date.now() });
        writeDb(db);
        return sendJson(response, 201, { post: hydratePost(post, db, currentUser) });
      }

      if (request.method === "POST" && action === "request") {
        if (!post.rideRequests.includes(currentUser.id)) post.rideRequests.push(currentUser.id);
        writeDb(db);
        return sendJson(response, 200, { post: hydratePost(post, db, currentUser) });
      }
    }

    if (request.method === "GET" && url.pathname === "/api/clubs") {
      const clubs = db.clubs.map((club) => ({
        ...club,
        memberCount: club.members.length,
        joined: user ? club.members.includes(user.id) : false,
      }));
      return sendJson(response, 200, { clubs });
    }

    const clubJoin = url.pathname.match(/^\/api\/clubs\/([^/]+)\/join$/);
    if (request.method === "POST" && clubJoin) {
      const currentUser = requireUser(request, response, db);
      if (!currentUser) return;
      const club = db.clubs.find((item) => item.id === clubJoin[1]);
      if (!club) return sendJson(response, 404, { error: "Club not found" });
      if (!club.members.includes(currentUser.id)) club.members.push(currentUser.id);
      writeDb(db);
      return sendJson(response, 200, { club: { ...club, memberCount: club.members.length, joined: true } });
    }

    return sendJson(response, 404, { error: "API route not found" });
  } catch (error) {
    return sendJson(response, 500, { error: error.message || "Server error" });
  }
}

function serveStatic(request, response, url) {
  const requestPath = decodeURIComponent(url.pathname);
  const relativePath = requestPath === "/" ? "index.html" : requestPath.slice(1);
  const filePath = path.resolve(__dirname, relativePath);

  if (!filePath.startsWith(__dirname) || filePath.includes(`${path.sep}data${path.sep}`)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      fs.readFile(path.join(__dirname, "index.html"), (fallbackError, fallback) => {
        if (fallbackError) {
          response.writeHead(404);
          response.end("Not found");
          return;
        }
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(fallback);
      });
      return;
    }
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": requestPath === "/sw.js" ? "no-cache" : "public, max-age=3600",
    });
    response.end(data);
  });
}

ensureDatabase();

http
  .createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      handleApi(request, response, url);
      return;
    }
    // Proxy /uploads/* through R2 when USE_R2 is true and no public URL is set
    if (USE_R2 && !R2_PUBLIC_URL && url.pathname.startsWith("/uploads/")) {
      const key = url.pathname.slice(1); // strip leading /
      const region  = "auto";
      const service = "s3";
      const host    = `${R2_BUCKET}.${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
      const now     = new Date();
      const amzDate   = now.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15) + "Z";
      const dateStamp = amzDate.slice(0, 8);
      const payloadHash = sha256Hex("");
      const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
      const signedHeaders    = "host;x-amz-content-sha256;x-amz-date";
      const canonicalRequest = ["GET", `/${key}`, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
      const credentialScope  = `${dateStamp}/${region}/${service}/aws4_request`;
      const stringToSign     = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
      const signature        = hmacSha256(getSigningKey(R2_SECRET_KEY, dateStamp, region, service), stringToSign).toString("hex");
      const authHeader       = `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
      const r2Req = https.request({
        hostname: host,
        path: `/${key}`,
        method: "GET",
        headers: {
          "host": host,
          "x-amz-content-sha256": payloadHash,
          "x-amz-date": amzDate,
          "Authorization": authHeader,
        },
      }, (r2Res) => {
        response.writeHead(r2Res.statusCode, {
          "Content-Type": r2Res.headers["content-type"] || "application/octet-stream",
          "Cache-Control": "public, max-age=31536000",
        });
        r2Res.pipe(response);
      });
      r2Req.on("error", () => { response.writeHead(502); response.end("R2 proxy error"); });
      r2Req.end();
      return;
    }
    serveStatic(request, response, url);
  })
  .listen(PORT, HOST, () => {
    console.log(`MTB Share running at http://${HOST}:${PORT}/ — storage: ${USE_R2 ? "Cloudflare R2" : "local disk"}`);
  });

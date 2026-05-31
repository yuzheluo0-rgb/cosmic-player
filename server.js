const express = require("express");
const session = require("express-session");
const path = require("path");
const axios = require("axios");
const fs = require("fs");
const os = require("os");

// Load .env
try {
  const envContent = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  envContent.split(/\r?\n/).forEach(line => {
    const eq = line.indexOf("=");
    if (eq > 0) process.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  });
} catch {}

const app = express();
const PORT = process.env.PORT || 3000;
const GROQ_KEY = process.env.GROQ_KEY || "";

let groq = null;
if (GROQ_KEY) {
  const Groq = require("groq-sdk").default;
  groq = new Groq({ apiKey: GROQ_KEY });
}

// ===== QQ OAuth 配置 =====
// 去 https://connect.qq.com 注册应用获取 AppID 和 AppKey
const QQ_APP_ID = process.env.QQ_APP_ID || "YOUR_QQ_APP_ID";
const QQ_APP_KEY = process.env.QQ_APP_KEY || "YOUR_QQ_APP_KEY";
const QQ_REDIRECT = process.env.QQ_REDIRECT || `http://localhost:${PORT}/oauth/qq/callback`;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
const FileStore = require("session-file-store")(session);
app.use(session({
  store: new FileStore({ path: path.join(__dirname, "data/sessions"), ttl: 7 * 24 * 3600 }),
  secret: "cosmic-player-singer-space-2025",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 3600 * 1000 },
}));

// ===== 网易云 API 加载 =====
let cloudMusicApi = null;
async function getCloudApi() {
  if (cloudMusicApi) return cloudMusicApi;
  try {
    const netease = require("NeteaseCloudMusicApi");
    cloudMusicApi = netease;
    console.log("NeteaseCloudMusicApi loaded");
    return cloudMusicApi;
  } catch (e) {
    console.error("Failed to load NeteaseCloudMusicApi:", e.message);
    return null;
  }
}

// 获取当前用户的网易云 cookie（session 优先，用户隔离）
function getUserCookie(req) {
  return req.session?.user?.cookie || "";
}
function isLoggedIn(req) {
  return !!(req.session?.user?.cookie);
}

// ===== 网易云手机号/邮箱登录 =====
app.post("/api/login/netease/cellphone", async (req, res) => {
  const { phone, password, countrycode } = req.body;
  if (!phone || !password) return res.status(400).json({ error: "手机号和密码不能为空" });
  try {
    const api = await getCloudApi();
    const result = await api.login_cellphone({ phone, password, countrycode: countrycode || "86" });
    if (result.body.code === 200) {
      const uid = result.body.account?.id || result.body.profile?.userId;
      req.session.user = { userId: uid, nickname: result.body.profile?.nickname || phone, avatar: result.body.profile?.avatarUrl || "", platform: "netease", cookie: result.body.cookie };
      req.session.uid = uid;
      // cookie stored in session only (user isolation)
      res.json({ ok: true, user: req.session.user });
    } else {
      res.json({ ok: false, message: result.body.message || result.body.msg || "登录失败" });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 网易云邮箱登录 =====
app.post("/api/login/netease/email", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "邮箱和密码不能为空" });
  try {
    const api = await getCloudApi();
    const result = await api.login({ email, password });
    if (result.body.code === 200) {
      const uid = result.body.account?.id || result.body.profile?.userId;
      req.session.user = { userId: uid, nickname: result.body.profile?.nickname || email, avatar: result.body.profile?.avatarUrl || "", platform: "netease", cookie: result.body.cookie };
      req.session.uid = uid;
      // cookie stored in session only (user isolation)
      res.json({ ok: true, user: req.session.user });
    } else {
      res.json({ ok: false, message: result.body.message || "登录失败" });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 网易云扫码登录 =====
app.get("/api/login/netease/qr/key", async (req, res) => {
  try {
    const api = await getCloudApi();
    const result = await api.login_qr_key();
    res.json(result.body);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/login/netease/qr/check", async (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json({ error: "key required" });
  try {
    const api = await getCloudApi();
    const result = await api.login_qr_check({ key });
    if (result.body.code === 803) {
      const cookie = result.body.cookie;
      let uid = "", nickname = "网易云用户", avatar = "";
      try {
        const detail = await api.user_detail({ cookie });
        const profile = detail.body?.profile || detail.body;
        if (profile) { uid = String(profile.userId || ""); nickname = profile.nickname || nickname; avatar = profile.avatarUrl || ""; }
      } catch {}
      // Fallback: cookie MUSIC_U
      if (!uid) { const m = cookie?.match(/MUSIC_U=(\d+)/); uid = m ? m[1] : ""; }
      req.session.user = { userId: uid, nickname, avatar, platform: "netease", cookie };
      req.session.uid = uid;
    }
    res.json(result.body);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/login/qq", (req, res) => {
  const state = Math.random().toString(36).slice(2, 10);
  req.session.oauthState = state;
  const url = `https://graph.qq.com/oauth2.0/authorize?response_type=code&client_id=${QQ_APP_ID}&redirect_uri=${encodeURIComponent(QQ_REDIRECT)}&state=${state}&scope=get_user_info`;
  res.json({ url });
});

app.get("/oauth/qq/callback", async (req, res) => {
  const { code, state } = req.query;
  if (state !== req.session.oauthState) {
    return res.status(403).send("State mismatch — possible CSRF attack");
  }

  try {
    // Step 1: code → access_token
    const tokenRes = await axios.get("https://graph.qq.com/oauth2.0/token", {
      params: {
        grant_type: "authorization_code",
        client_id: QQ_APP_ID,
        client_secret: QQ_APP_KEY,
        code,
        redirect_uri: QQ_REDIRECT,
        fmt: "json",
      },
    });
    const accessToken = tokenRes.data.access_token;

    // Step 2: access_token → openid
    const openidRes = await axios.get("https://graph.qq.com/oauth2.0/me", {
      params: { access_token: accessToken, fmt: "json" },
    });
    const openid = openidRes.data.openid;

    // Step 3: openid + access_token → user info
    const userRes = await axios.get("https://graph.qq.com/user/get_user_info", {
      params: {
        access_token: accessToken,
        oauth_consumer_key: QQ_APP_ID,
        openid,
      },
    });
    const user = userRes.data;

    req.session.user = {
      openid,
      nickname: user.nickname,
      avatar: user.figureurl_qq_2 || user.figureurl_qq_1,
      platform: "qq",
    };

    res.redirect("/");
  } catch (e) {
    console.error("QQ OAuth error:", e.message);
    res.status(500).send("QQ 登录失败: " + e.message);
  }
});

// ===== 二维码生成（服务端渲染，不依赖外部API）=====
const QRCode = require("qrcode");

app.get("/api/qrcode", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send("url required");
  try {
    const dataUrl = await QRCode.toDataURL(url, { width: 200, margin: 2, color: { dark: "#000", light: "#fff" } });
    res.json({ dataUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/netease/user", async (req, res) => {
  try {
    const api = await getCloudApi();
    const cookie = getUserCookie(req);
    if (!cookie) return res.json(null);
    const result = await api.user_detail({ cookie });
    const profile = result.body?.profile || result.body;
    res.json(profile ? {
      nickname: profile.nickname,
      avatar: profile.avatarUrl,
      userId: profile.userId,
    } : null);
  } catch (e) { res.json(null); }
});

// ===== 退出登录 =====
app.post("/api/netease/logout", (req, res) => {
  req.session.user = null;
  req.session.uid = null;
  res.json({ ok: true });
});

// ===== 网易云个人功能（需要登录）=====
app.get("/api/netease/recommend", async (req, res) => {
  try {
    const api = await getCloudApi();
    const cookie = getUserCookie(req);
    if (!cookie) return res.status(401).json({ error: "请先登录网易云" });
    const result = await api.recommend_songs({ cookie });
    res.json(result.body);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/netease/playlists", async (req, res) => {
  try {
    const api = await getCloudApi();
    const cookie = getUserCookie(req);
    if (!cookie) return res.status(401).json({ error: "请先登录网易云" });
    let uid = req.session.uid || req.session.user?.userId;
    // If uid is short (from old MUSIC_U extraction), get real uid from API
    if (uid && uid.length < 5) {
      try { const detail = await api.user_detail({ cookie }); uid = String((detail.body?.profile || detail.body)?.userId || uid); req.session.uid = uid; } catch {}
    }
    if (!uid) {
      try { const detail = await api.user_detail({ cookie }); uid = String((detail.body?.profile || detail.body)?.userId || ""); } catch {}
    }
    if (!uid) {
      try { const acct = await api.user_account({ cookie }); uid = String(acct.body?.account?.id || acct.body?.profile?.userId || ""); } catch {}
    }
    if (!uid) { const m = cookie.match(/MUSIC_U=(\d+)/); if (m) uid = m[1]; }
    if (uid) req.session.uid = uid;
    if (!uid) return res.status(401).json({ error: "请先登录网易云" });
    const result = await api.user_playlist({ uid: String(uid), cookie });
    res.json(result.body);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/netease/playlist/detail", async (req, res) => {
  try {
    const api = await getCloudApi();
    const cookie = getUserCookie(req);
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "id required" });
    const result = await api.playlist_detail({ id, cookie });
    res.json(result.body);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/netease/likelist", async (req, res) => {
  try {
    const api = await getCloudApi();
    const cookie = getUserCookie(req);
    if (!cookie) return res.status(401).json({ error: "请先登录网易云" });
    let uid = req.session.uid || req.session.user?.userId;
    if (uid && uid.length < 5) {
      try { const detail = await api.user_detail({ cookie }); uid = String((detail.body?.profile || detail.body)?.userId || uid); req.session.uid = uid; } catch {}
    }
    if (!uid) {
      try { const detail = await api.user_detail({ cookie }); uid = String((detail.body?.profile || detail.body)?.userId || ""); } catch {}
    }
    if (!uid) {
      try { const acct = await api.user_account({ cookie }); uid = String(acct.body?.account?.id || acct.body?.profile?.userId || ""); } catch {}
    }
    if (!uid) { const m = cookie.match(/MUSIC_U=(\d+)/); if (m) uid = m[1]; }
    if (uid) req.session.uid = uid;
    if (!uid) return res.json({ ids: [] });
    const result = await api.likelist({ uid, cookie });
    res.json(result.body);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/netease/likelist/songs", async (req, res) => {
  try {
    const api = await getCloudApi();
    const cookie = getUserCookie(req);
    if (!cookie) return res.status(401).json({ error: "请先登录网易云" });
    let uid = req.session.uid || req.session.user?.userId;
    if (uid && uid.length < 5) {
      try { const detail = await api.user_detail({ cookie }); uid = String((detail.body?.profile || detail.body)?.userId || uid); req.session.uid = uid; } catch {}
    }
    if (!uid) {
      try { const detail = await api.user_detail({ cookie }); uid = String((detail.body?.profile || detail.body)?.userId || ""); } catch {}
    }
    if (!uid) {
      try { const acct = await api.user_account({ cookie }); uid = String(acct.body?.account?.id || acct.body?.profile?.userId || ""); } catch {}
    }
    if (!uid) { const m = cookie.match(/MUSIC_U=(\d+)/); if (m) uid = m[1]; }
    if (uid) req.session.uid = uid;
    if (!uid) return res.json({ songs: [] });
    const { offset = 0, limit = 200 } = req.query;
    const songs = [];
    // Fetch in batches
    const result = await api.likelist({ uid, cookie });
    const ids = result.body?.ids || [];
    const batchSize = Math.min(parseInt(limit), ids.length);
    const start = parseInt(offset);
    const batchIds = ids.slice(start, start + batchSize);
    if (batchIds.length === 0) return res.json({ songs: [], total: ids.length });
    const detail = await api.song_detail({ ids: batchIds.join(","), cookie });
    res.json({ songs: detail.body?.songs || [], total: ids.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/stream/:id", async (req, res) => {
  try {
    const api = await getCloudApi();
    if (!api) return res.status(503).json({ error: "API unavailable" });
    const result = await api.song_url_v1({ id: req.params.id, level: "lossless" });
    const url = result.body?.data?.[0]?.url;
    if (!url) return res.status(404).json({ error: "No playable URL" });

    const range = req.headers.range;
    const axiosOpts = {
      responseType: "stream",
      headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://music.163.com/" },
      timeout: 60000,
    };
    if (range) axiosOpts.headers.Range = range;

    const { data, headers: up } = await axios.get(url, axiosOpts);
    const status = range ? 206 : 200;
    const resHeaders = {
      "Content-Type": up["content-type"] || "audio/mpeg",
      "Accept-Ranges": "bytes",
    };
    if (range) {
      resHeaders["Content-Range"] = up["content-range"] || `bytes */${up["content-length"] || "*"}`;
    }
    if (up["content-length"]) resHeaders["Content-Length"] = up["content-length"];
    res.writeHead(status, resHeaders);
    data.pipe(res);
    data.on("error", () => { if (!res.headersSent) res.status(500).end(); });
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});
app.get("/api/user", (req, res) => {
  if (req.session.user) {
    res.json(req.session.user);
  } else {
    res.json(null);
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// ===== 网易云 API 代理 =====
app.all("/api/music/*", async (req, res) => {
  const api = await getCloudApi();
  if (!api) return res.status(503).json({ error: "Music API not available" });

  const endpoint = req.path.replace("/api/music/", "");
  const handler = api[endpoint];

  if (!handler) return res.status(404).json({ error: `Unknown endpoint: ${endpoint}` });

  try {
    const params = { ...req.query, ...req.body };
    // Ensure cookie support for VIP tracks
    const cookie = getUserCookie(req);
    if (cookie) {
      params.cookie = cookie;
    }
    const result = await handler(params);
    res.json(result.body || result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 网易公版影像典藏计划 — 视频解析 =====
const neteaseCache = new Map();

function parseJsonp(text) {
  const match = text.match(/^_callback\((.+)\);?\s*$/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

app.get("/api/public163/entry/:id", async (req, res) => {
  const entryId = req.params.id;
  const cached = neteaseCache.get(`entry-${entryId}`);
  if (cached && Date.now() < cached.expiry) return res.json(cached.data);

  try {
    // Step 1: Get entry metadata
    const entryResp = await axios.get(
      `https://active.163.com/service/form/v1/9347/${entryId}.jsonp`,
      { timeout: 10000, headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://public.163.com/" } }
    );
    const entryData = parseJsonp(entryResp.data);
    if (!entryData || entryData.status !== "success") {
      return res.status(404).json({ error: "Entry not found" });
    }
    const entry = entryData.value;

    // Step 2: Get video stream URLs
    let streamUrl = null, posterUrl = entry.cover_pic || null;
    if (entry.vid) {
      try {
        const vidResp = await axios.get(
          `https://so.v.163.com/mobile/getBatchOnlineVideo.do`,
          { params: { vidstr: entry.vid }, timeout: 10000,
            headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://public.163.com/" } }
        );
        const vlist = vidResp.data?.data?.video_list || [];
        if (vlist.length > 0) {
          const v = vlist[0];
          // Prefer MP4 SD (stable), fallback to m3u8
          streamUrl = v.mp4SdUrl || v.mp4ShdUrl || v.mp4HdUrl || v.m3u8SdUrl || v.m3u8HdUrl || "";
          if (v.imgpath) posterUrl = v.imgpath;
        }
      } catch {}
    }

    const result = {
      title: entry.title || "",
      titleEn: entry.media_name || "",
      year: (entry.release_date || "").slice(0, 4),
      description: (entry.desc || "").replace(/<[^>]+>/g, "").slice(0, 300),
      director: entry.director || "",
      cast: entry.protagonist || "",
      genre: entry.meida_type || "",
      runtime: entry.film_length || "",
      posterUrl,
      streamUrl,
    };

    neteaseCache.set(`entry-${entryId}`, { data: result, expiry: Date.now() + 600000 });
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ===== 哔哩哔哩视频信息代理（已弃用，保留兼容）=====
app.get("/api/bilibili/info", async (req, res) => {
  const { bvid } = req.query;
  if (!bvid) return res.status(400).json({ error: "bvid required" });
  try {
    const { data } = await axios.get(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
      headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com/" },
      timeout: 10000,
    });
    if (data.code !== 0) return res.json({ error: data.message || "Bilibili API error" });
    res.json({
      title: data.data.title,
      pic: data.data.pic,
      pages: (data.data.pages || []).map(p => ({ page: p.page, part: p.part, duration: p.duration })),
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ===== 宇宙电台 =====
const radioCache = new Map();

// Quick GET check with small range — many stream servers reject HEAD
async function checkStreamAlive(url, timeout = 5000) {
  try {
    const resp = await axios.get(url, {
      timeout,
      headers: { "User-Agent": "Mozilla/5.0", "Icy-MetaData": "0" },
      maxRedirects: 3,
      validateStatus: s => s < 500,
      responseType: "stream",
    });
    resp.data.destroy();
    return true;
  } catch { return false; }
}

// Background connectivity check — runs after response, caches alive stations
async function checkAllStations(stations, cacheKey) {
  const BATCH = 40;
  const alive = [];
  for (let i = 0; i < stations.length; i += BATCH) {
    const batch = stations.slice(i, i + BATCH);
    const checks = await Promise.allSettled(
      batch.map(s => checkStreamAlive(s.url, 5000))
    );
    for (let j = 0; j < batch.length; j++) {
      if (checks[j].status === "fulfilled" && checks[j].value) alive.push(batch[j]);
    }
    // Small yield to not block event loop
    await new Promise(r => setTimeout(r, 0));
  }
  if (alive.length > 50) {
    radioCache.set(cacheKey, { data: { stations: alive, total: alive.length }, expiry: Date.now() + 7200000 });
    console.log(`Radio check done: ${alive.length}/${stations.length} alive, cache updated`);
  }
}

app.get("/api/radio/stations", async (req, res) => {
  const cacheKey = "radio-stations";
  const cached = radioCache.get(cacheKey);
  if (cached && Date.now() < cached.expiry) return res.json(cached.data);

  try {
    const genres = [
      // === 叙事 / 故事 / 恐怖 ===
      { tag: "talk", name: "🎙️ 访谈" },
      { tag: "storytelling", name: "📖 故事" },
      { tag: "podcast", name: "🎧 播客" },
      { tag: "horror", name: "👻 恐怖故事", limit: 40 },
      { tag: "horror story", name: "👻 恐怖故事", limit: 30 },
      { tag: "creepypasta", name: "👻 都市怪谈", limit: 20 },
      { tag: "scary", name: "👻 惊悚故事", limit: 20 },
      { tag: "ghost", name: "👻 灵异", limit: 20 },
      { tag: "paranormal", name: "👻 超自然", limit: 20 },
      { tag: "spooky", name: "👻 诡异", limit: 15 },
      { tag: "true crime", name: "👻 真实犯罪", limit: 20 },
      { tag: "mystery", name: "👻 悬疑探案", limit: 20 },
      { tag: "dark ambient", name: "👻 黑暗氛围", limit: 15 },
      { tag: "gothic", name: "👻 哥特", limit: 15 },
      { tag: "occult", name: "👻 神秘学", limit: 15 },
      { tag: "creepy", name: "👻 毛骨悚然", limit: 15 },
      { tag: "audiobook", name: "📚 有声书" },
      { tag: "drama", name: "🎭 广播剧" },
      { tag: "news", name: "📰 新闻" },
      // === 中文电台 ===
      { tag: "chinese", name: "🇨🇳 中文电台" },
      { tag: "cantonese", name: "🇭🇰 粤语" },
      { tag: "mandarin", name: "🗣️ 国语" },
      // === 音乐 ===
      { tag: "ambient", name: "氛围" },
      { tag: "chillout", name: "驰放" },
      { tag: "lofi", name: "Lo-Fi" },
      { tag: "jazz", name: "爵士" },
      { tag: "classical", name: "古典" },
      { tag: "electronic", name: "电子" },
      { tag: "house", name: "House" },
      { tag: "techno", name: "Techno" },
      { tag: "drum and bass", name: "鼓打贝斯" },
      { tag: "indie", name: "独立" },
      { tag: "rock", name: "摇滚" },
      { tag: "metal", name: "金属" },
      { tag: "hip hop", name: "嘻哈" },
      { tag: "rnb", name: "R&B" },
      { tag: "soul", name: "灵魂" },
      { tag: "funk", name: "放克" },
      { tag: "reggae", name: "雷鬼" },
      { tag: "latin", name: "拉丁" },
      { tag: "world", name: "世界音乐" },
      { tag: "jpop", name: "J-Pop" },
      { tag: "kpop", name: "K-Pop" },
      { tag: "anime", name: "动漫" },
      { tag: "80s", name: "80年代" },
      { tag: "90s", name: "90年代" },
      { tag: "disco", name: "迪斯科" },
      { tag: "blues", name: "蓝调" },
      { tag: "country", name: "乡村" },
      { tag: "folk", name: "民谣" },
      { tag: "soundtrack", name: "原声" },
      { tag: "new age", name: "新世纪" },
      { tag: "downtempo", name: "慢节奏" },
      { tag: "trance", name: "Trance" },
      { tag: "deep house", name: "Deep House" },
      { tag: "synthwave", name: "合成波" },
      { tag: "vaporwave", name: "蒸汽波" },
      { tag: "piano", name: "钢琴" },
      { tag: "guitar", name: "吉他" },
      { tag: "celtic", name: "凯尔特" },
      { tag: "meditation", name: "冥想" },
      // Additional Chinese-specific tags
      { tag: "china", name: "🇨🇳 中国电台", limit: 30 },
      { tag: "chinese talk", name: "中文谈话", limit: 20 },
    ];

    // Pre-built list of known working Chinese domestic radio streams
    const chinaStations = [
      { name: "CNR 中国之声", url: "http://ngcdn001.cnr.cn/live/zgzs/index.m3u8", category: "🇨🇳 中国电台", country: "China", codec: "HLS", bitrate: 128, tags: "news,china,mandarin" },
      { name: "CNR 音乐之声", url: "http://ngcdn002.cnr.cn/live/yyzs/index.m3u8", category: "🇨🇳 中国电台", country: "China", codec: "HLS", bitrate: 128, tags: "music,china,mandarin" },
      { name: "CNR 经济之声", url: "http://ngcdn003.cnr.cn/live/jjzs/index.m3u8", category: "🇨🇳 中国电台", country: "China", codec: "HLS", bitrate: 128, tags: "news,china,mandarin" },
      { name: "北京音乐广播", url: "http://lhttp.qingting.fm/live/333/64k.mp3", category: "🇨🇳 中国电台", country: "China", codec: "MP3", bitrate: 64, tags: "music,china,mandarin" },
      { name: "上海动感101", url: "http://lhttp.qingting.fm/live/274/64k.mp3", category: "🇨🇳 中国电台", country: "China", codec: "MP3", bitrate: 64, tags: "pop,china,mandarin" },
      { name: "广东音乐之声", url: "http://lhttp.qingting.fm/live/1257/64k.mp3", category: "🇨🇳 中国电台", country: "China", codec: "MP3", bitrate: 64, tags: "music,cantonese,china" },
      { name: "深圳音乐广播", url: "http://lhttp.qingting.fm/live/1271/64k.mp3", category: "🇨🇳 中国电台", country: "China", codec: "MP3", bitrate: 64, tags: "music,china,mandarin" },
      { name: "成都交通广播", url: "http://lhttp.qingting.fm/live/1522/64k.mp3", category: "🇨🇳 中国电台", country: "China", codec: "MP3", bitrate: 64, tags: "traffic,china,mandarin" },
      { name: "杭州西湖之声", url: "http://lhttp.qingting.fm/live/1162/64k.mp3", category: "🇨🇳 中国电台", country: "China", codec: "MP3", bitrate: 64, tags: "music,china,mandarin" },
      { name: "南京音乐广播", url: "http://lhttp.qingting.fm/live/1189/64k.mp3", category: "🇨🇳 中国电台", country: "China", codec: "MP3", bitrate: 64, tags: "music,china,mandarin" },
      { name: "天津音乐广播", url: "http://lhttp.qingting.fm/live/383/64k.mp3", category: "🇨🇳 中国电台", country: "China", codec: "MP3", bitrate: 64, tags: "music,china,mandarin" },
      { name: "重庆音乐广播", url: "http://lhttp.qingting.fm/live/1510/64k.mp3", category: "🇨🇳 中国电台", country: "China", codec: "MP3", bitrate: 64, tags: "music,china,mandarin" },
    ];

    const baseUrl = "https://de1.api.radio-browser.info/json/stations/search";
    const stationsMap = new Map();

    // Phase 1: Fetch from Radio Browser (by genre)
    const queries = genres.map(async ({ tag, name, limit }) => {
      const lim = limit || 50;
      try {
        const resp = await axios.get(baseUrl, {
          params: { tag, limit: lim, hidebroken: true, order: "clickcount", reverse: true },
          timeout: 8000,
          headers: { "User-Agent": "Mozilla/5.0" },
        });
          return (resp.data || []).map(s => ({
            id: s.stationuuid,
            name: s.name,
            url: s.url_resolved || s.url,
            homepage: s.homepage || "",
            favicon: s.favicon || "",
            tags: s.tags || "",
            country: s.country || "",
            codec: (s.codec || "").toUpperCase(),
            bitrate: s.bitrate || 0,
            votes: s.votes || 0,
            category: name,
          })).filter(s => s.url && s.url.startsWith("http"));
        } catch { return []; }
      })

    // Also fetch top-clicked stations globally (no genre filter) for more diversity
    queries.push((async () => {
      try {
        const resp = await axios.get(baseUrl, {
          params: { limit: 200, hidebroken: true, order: "clickcount", reverse: true },
          timeout: 8000,
          headers: { "User-Agent": "Mozilla/5.0" },
        });
        return (resp.data || []).map(s => ({
          id: s.stationuuid,
          name: s.name,
          url: s.url_resolved || s.url,
          homepage: s.homepage || "",
          favicon: s.favicon || "",
          tags: s.tags || "",
          country: s.country || "",
          codec: (s.codec || "").toUpperCase(),
          bitrate: s.bitrate || 0,
          votes: s.votes || 0,
          category: "热门电台",
        })).filter(s => s.url && s.url.startsWith("http"));
      } catch { return []; }
    })());

    const results = await Promise.allSettled(queries);
    for (const r of results) {
      if (r.status === "fulfilled") {
        for (const s of r.value) {
          if (!stationsMap.has(s.id)) stationsMap.set(s.id, s);
        }
      }
    }

    let allStations = Array.from(stationsMap.values());

    // Add Chinese domestic stations (assign pseudo-IDs to avoid dedup)
    chinaStations.forEach((s, i) => {
      allStations.push({
        id: "cn_" + i,
        name: s.name,
        url: s.url,
        homepage: "",
        favicon: "",
        tags: s.tags || "",
        country: s.country || "China",
        codec: s.codec || "MP3",
        bitrate: s.bitrate || 64,
        votes: 9999,
        category: s.category,
      });
    });

    // Filter out non-playable streams (m3u8/HLS, playlist files)
    allStations = allStations.filter(s => {
      const url = (s.url || "").toLowerCase();
      if (url.includes(".m3u8") || url.includes(".m3u")) return false;
      if (url.endsWith(".pls") || url.endsWith(".asx")) return false;
      return true;
    });

    // Shuffle for diversity
    for (let i = allStations.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allStations[i], allStations[j]] = [allStations[j], allStations[i]];
    }

    const result = { stations: allStations, total: allStations.length };
    radioCache.set(cacheKey, { data: result, expiry: Date.now() + 3600000 });
    res.json(result);

    // Background: connectivity check, update cache with alive-only results
    checkAllStations(allStations, cacheKey);

  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ===== 精选稳定电台 (本地 JSON, 走代理保证长期可用) =====
let stableStations = null;
function loadStableStations() {
  if (stableStations) return stableStations;
  try {
    const raw = fs.readFileSync(path.join(__dirname, "radio-stable.json"), "utf8");
    const data = JSON.parse(raw);
    stableStations = (data.stations || []).filter(s => {
      const url = (s.url || "").toLowerCase();
      if (url.includes(".m3u8") || url.endsWith(".pls") || url.endsWith(".asx")) return false;
      return url.startsWith("http");
    }).map((s, i) => ({
      id: "stable_" + i,
      name: s.name,
      url: s.url,
      proxyUrl: "/api/radio/proxy?url=" + encodeURIComponent(s.url),
      homepage: "",
      favicon: "",
      tags: s.country || "",
      country: s.country || "",
      codec: s.codec || "",
      bitrate: s.bitrate || 0,
      votes: 9999,
      category: s.category,
    }));
  } catch (e) {
    stableStations = [];
  }
  return stableStations;
}

app.get("/api/radio/stable", (req, res) => {
  const stations = loadStableStations();
  res.json({ stations, total: stations.length, source: "curated" });
});

// ===== 电台流代理 =====
app.get("/api/radio/proxy", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "url required" });
  try {
    const resp = await axios.get(url, {
      responseType: "stream",
      timeout: 8000,
      headers: { "User-Agent": "Mozilla/5.0", "Icy-MetaData": "0" },
      maxRedirects: 3,
    });
    if (!resp.data) return res.status(502).end();
    const ct = resp.headers["content-type"] || "audio/mpeg";
    res.setHeader("Content-Type", ct);
    resp.data.pipe(res);
    req.on("close", () => { try { resp.data.destroy(); } catch {} });
  } catch (e) {
    res.status(502).json({ error: "proxy failed" });
  }
});

// ===== 宇宙书库 — Gutenberg 公版书代理 =====
const booksData = JSON.parse(fs.readFileSync(path.join(__dirname, "books.json"), "utf8"));
const bookCache = new Map();

// Split text into "chapters" by common markers
function splitChapters(text) {
  const chapters = [];

  // Remove Gutenberg header (everything before the first substantial content)
  const headerEndPatterns = [
    /\*{3}\s*START\s*(OF|of)\s*(THE|THIS)\s*PROJECT\s*GUTENBERG[^*]*\*{3}/i,
    /START OF (THE |THIS )?PROJECT GUTENBERG/i,
  ];
  let body = text;
  for (const pat of headerEndPatterns) {
    const m = body.match(pat);
    if (m && m.index > 0) {
      body = body.slice(m.index + m[0].length);
      break;
    }
  }

  // Also remove footer
  const footerStart = body.search(/\*{3}\s*END\s*(OF|of)\s*(THE|THIS)\s*PROJECT\s*GUTENBERG/i);
  if (footerStart > 0) body = body.slice(0, footerStart);

  // Combined pattern: English CHAPTER/Letter/etc + Chinese 第X回/第X章/第X部/第X卷 + 上部/中部/下部
  const combinedPat = /(?:[\r\n]{3,})\s*(?:CHAPTER|Chapter|LETTER|Letter|BOOK|Book|PART|Part|ACT|Act|CANTO|Canto)\s+(?:[IVXLCDM]+|\d+)\b|(?:^|[\r\n])(?:第[一二三四五六七八九十百千\d]+[部卷回章节]|[上中下]部)[\s　：:]+/gm;

  const allMatches = [...body.matchAll(combinedPat)];
  if (allMatches.length >= 2 && allMatches.length <= 200) {
      // Preface
      const preface = body.slice(0, allMatches[0].index).trim();
      if (preface.length > 400) {
        chapters.push({ title: "前言 / 序", content: preface });
      }
      // Chapters
      const rawChapters = [];
      for (let i = 0; i < allMatches.length; i++) {
        const start = allMatches[i].index;
        const end = i + 1 < allMatches.length ? allMatches[i + 1].index : body.length;
        // Extend title to include rest of the header line (for Chinese books like "第一部  第1章 科学边界")
        const afterMarker = body.slice(start + allMatches[i][0].length, end);
        const lineEnd = afterMarker.search(/[\r\n]/);
        const extraTitle = lineEnd > 0 ? afterMarker.slice(0, lineEnd).trim() : "";
        const fullTitle = (allMatches[i][0].replace(/\r/g, "").trim() + (extraTitle ? " " + extraTitle : "")).trim();
        const contentStart = lineEnd > 0 ? lineEnd + 1 : 0;
        rawChapters.push({
          title: fullTitle,
          content: afterMarker.slice(contentStart).trim(),
        });
      }
      // Filter out TOC entries: any chapter with <600 chars is likely a TOC stub
      // But if ALL chapters are small, keep them all
      const hasBigChapter = rawChapters.some(c => c.content.length >= 600);
      if (hasBigChapter) {
        // Collect TOC stubs into preface
        const tocParts = [];
        const realChaps = [];
        for (let i = 0; i < rawChapters.length; i++) {
          if (rawChapters[i].content.length < 600) {
            tocParts.push(rawChapters[i]);
          } else {
            realChaps.push(rawChapters[i]);
          }
        }
        if (tocParts.length > 0 && tocParts.length < rawChapters.length) {
          const tocText = tocParts.map(c => (c.title + "\n" + c.content).trim()).join("\n\n");
          if (chapters.length === 0) chapters.push({ title: "前言 / 目录", content: tocText });
          else chapters[0].content = tocText;
        }
        rawChapters.length = 0;
        rawChapters.push(...realChaps);
      }
      for (let i = 0; i < rawChapters.length; i++) {
        if (rawChapters[i].content.length > 100 || i === rawChapters.length - 1) {
          chapters.push(rawChapters[i]);
        }
      }
    }
  if (chapters.length >= 2) return chapters;

  // Fallback: split by double newlines into reasonable chunks (~5000 chars each)
  const paras = body.split(/\n{3,}/);
  const chunks = [];
  let current = "";
  for (const p of paras) {
    current += (current ? "\n\n" : "") + p;
    if (current.length > 8000) {
      chunks.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) chunks.push(current.trim());

  if (chunks.length >= 2) {
    return chunks.map((c, i) => ({
      title: "第 " + (i + 1) + " 段",
      content: c,
    }));
  }

  // Just one big chapter
  return [{ title: "", content: body.trim() }];
}

// GET /api/books — full book list
app.get("/api/books", (req, res) => {
  res.json(booksData);
});

// ===== 本地书库 =====
let localBooks = null;
function loadLocalBooks() {
  if (localBooks) return localBooks;
  try {
    const p = path.join(__dirname, "books-local", "manifest.json");
    if (!fs.existsSync(p)) { localBooks = []; return []; }
    localBooks = JSON.parse(fs.readFileSync(p, "utf8")).books || [];
    return localBooks;
  } catch (e) { localBooks = []; return []; }
}

app.get("/api/books/local", (req, res) => {
  res.json({ books: loadLocalBooks() });
});

app.get("/api/books/local/:id", (req, res) => {
  const books = loadLocalBooks();
  const meta = books.find(b => b.id === req.params.id);
  if (!meta) return res.status(404).json({ error: "Book not found" });

  const filePath = path.join(__dirname, "books-local", meta.file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found: " + meta.file });

  try {
    const text = fs.readFileSync(filePath, "utf8");
    const chapters = splitChapters(text);
    res.json({
      id: meta.id, title: meta.title, author: meta.author, category: meta.cat,
      lang: meta.lang, desc: meta.desc, totalChars: text.length, chapterCount: chapters.length,
      source: meta.source,
      chapters: chapters.map((ch, i) => ({
        index: i, title: ch.title, charCount: ch.content.length,
        preview: ch.content.slice(0, 200), fullText: ch.content,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/books/:id — book content (fetched from Gutenberg, parsed + cached)
app.get("/api/books/:id", async (req, res) => {
  const { id } = req.params;
  const cacheKey = "book-" + id;
  const cached = bookCache.get(cacheKey);
  if (cached && Date.now() < cached.expiry) {
    return res.json(cached.data);
  }

  try {
    const meta = booksData.books.find(b => b.id === id);
    if (!meta) return res.status(404).json({ error: "Book not found" });

    const gutenbergUrl = `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`;
    const resp = await axios.get(gutenbergUrl, {
      timeout: 30000,
      headers: { "User-Agent": "Mozilla/5.0" },
      responseType: "text",
    });

    const text = resp.data;
    const chapters = splitChapters(text);
    const totalChars = text.length;

    const result = {
      id, title: meta.title, author: meta.author, category: meta.cat,
      lang: meta.lang, desc: meta.desc, totalChars, chapterCount: chapters.length,
      chapters: chapters.map((ch, i) => ({
        index: i,
        title: ch.title,
        charCount: ch.content.length,
        preview: ch.content.slice(0, 200),
        fullText: ch.content,
      })),
    };

    bookCache.set(cacheKey, { data: result, expiry: Date.now() + 3600000 });
    res.json(result);
  } catch (e) {
    console.error("Book fetch error:", e.message);
    res.status(502).json({ error: "Gutenberg unreachable", message: e.message });
  }
});

// ===== 用户阅读数据（按网易云UID隔离）=====
const userDataDir = path.join(__dirname, "data");
try { if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir); } catch {}

function getUserDataPath(uid) { return path.join(userDataDir, `reader-${uid}.json`); }
function loadUserData(uid) {
  try {
    const p = getUserDataPath(uid);
    if (!fs.existsSync(p)) return { favorites: [], states: {} };
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch { return { favorites: [], states: {} }; }
}
function saveUserData(uid, data) {
  try { fs.writeFileSync(getUserDataPath(uid), JSON.stringify(data)); } catch {}
}

// GET /api/reading/state — 获取当前用户所有阅读进度
app.get("/api/reading/state", (req, res) => {
  const uid = req.session?.uid;
  if (!uid) return res.status(401).json({ error: "请先登录网易云" });
  const data = loadUserData(uid);
  res.json({ states: data.states || {} });
});

// POST /api/reading/state — 保存单本书阅读进度 { bookId, chapter, progress }
app.post("/api/reading/state", (req, res) => {
  const uid = req.session?.uid;
  if (!uid) return res.status(401).json({ error: "请先登录网易云" });
  const { bookId, chapter, progress } = req.body;
  if (!bookId) return res.status(400).json({ error: "bookId required" });
  const data = loadUserData(uid);
  if (!data.states) data.states = {};
  data.states[bookId] = { chapter: chapter || 0, progress: progress || 0, ts: Date.now() };
  saveUserData(uid, data);
  res.json({ ok: true });
});

// GET /api/reading/favorites — 获取收藏列表
app.get("/api/reading/favorites", (req, res) => {
  const uid = req.session?.uid;
  if (!uid) return res.status(401).json({ error: "请先登录网易云" });
  const data = loadUserData(uid);
  res.json({ favorites: data.favorites || [] });
});

// POST /api/reading/favorite — 切换收藏 { bookId }
app.post("/api/reading/favorite", (req, res) => {
  const uid = req.session?.uid;
  if (!uid) return res.status(401).json({ error: "请先登录网易云" });
  const { bookId } = req.body;
  if (!bookId) return res.status(400).json({ error: "bookId required" });
  const data = loadUserData(uid);
  if (!data.favorites) data.favorites = [];
  const idx = data.favorites.indexOf(bookId);
  if (idx >= 0) data.favorites.splice(idx, 1);
  else data.favorites.push(bookId);
  saveUserData(uid, data);
  res.json({ ok: true, favorited: idx < 0, favorites: data.favorites });
});

// ===== 时空虫洞 — 穿越百年 =====
const wormholeCache = new Map();
// Notable movies per year (1926-2025)
const moviesByYear = {
  1926:{title:"The General",dir:"Buster Keaton",desc:"蒸汽火车上的默片喜剧巅峰"},
  1927:{title:"Metropolis",dir:"Fritz Lang",desc:"德国表现主义科幻电影开山之作","poster":"https://image.tmdb.org/t/p/w500/qWiqDtONWADGW3Pd62O4WTgqJq0.jpg"},
  1928:{title:"The Passion of Joan of Arc",dir:"Carl Theodor Dreyer",desc:"德莱叶镜头下的圣女贞德受难"},
  1929:{title:"Man with a Movie Camera",dir:"Dziga Vertov",desc:"一部没有对白的城市交响曲"},
  1930:{title:"All Quiet on the Western Front",dir:"Lewis Milestone",desc:"一战最伟大的反战电影"},
  1931:{title:"City Lights",dir:"Charlie Chaplin",desc:"卓别林的无声浪漫杰作"},
  1932:{title:"Scarface",dir:"Howard Hawks",desc:"黑帮电影的经典原型"},
  1933:{title:"King Kong",dir:"Cooper & Schoedsack",desc:"巨猿爬上帝国大厦的永恒画面"},
  1934:{title:"It Happened One Night",dir:"Frank Capra",desc:"史上第一部奥斯卡大满贯影片"},
  1935:{title:"The 39 Steps",dir:"Alfred Hitchcock",desc:"希区柯克早期悬疑杰作"},
  1936:{title:"Modern Times",dir:"Charlie Chaplin",desc:"工业时代的无奈与幽默"},
  1937:{title:"Snow White and the Seven Dwarfs",dir:"David Hand",desc:"世界第一部动画长片"},
  1938:{title:"The Adventures of Robin Hood",dir:"Michael Curtiz",desc:"绿林英雄的彩色冒险"},
  1939:{title:"The Wizard of Oz",dir:"Victor Fleming",desc:"绿野仙踪，电影史上最魔幻的一年","poster":"https://image.tmdb.org/t/p/w500/mI36ZftLH3Pjahz9HNjFhEUJzMf.jpg"},
  1940:{title:"The Great Dictator",dir:"Charlie Chaplin",desc:"卓别林的大胆政治讽刺"},
  1941:{title:"Citizen Kane",dir:"Orson Welles",desc:"影史第一神作，玫瑰花的秘密","poster":"https://image.tmdb.org/t/p/w500/sav0jxhqiH0bPr2vZFUxjYRajbb.jpg"},
  1942:{title:"Casablanca",dir:"Michael Curtiz",desc:"永志不忘的巴黎","poster":"https://image.tmdb.org/t/p/w500/2nAHQbMGcIGM8kGqyRqThZ43eup.jpg"},
  1943:{title:"Shadow of a Doubt",dir:"Alfred Hitchcock",desc:"平静小镇下的暗流"},
  1944:{title:"Double Indemnity",dir:"Billy Wilder",desc:"黑色电影的完美范本"},
  1945:{title:"Rome, Open City",dir:"Roberto Rossellini",desc:"意大利新现实主义的诞生"},
  1946:{title:"It's a Wonderful Life",dir:"Frank Capra",desc:"每一个生命都改变了世界"},
  1947:{title:"Out of the Past",dir:"Jacques Tourneur",desc:"黑色电影中最黑色的那一部"},
  1948:{title:"Bicycle Thieves",dir:"Vittorio De Sica",desc:"意大利新现实主义巅峰"},
  1949:{title:"The Third Man",dir:"Carol Reed",desc:"战后维也纳的地下迷宫"},
  1950:{title:"Rashomon",dir:"Akira Kurosawa",desc:"黑泽明的记忆迷局"},
  1951:{title:"A Streetcar Named Desire",dir:"Elia Kazan",desc:"马龙·白兰度的怒吼"},
  1952:{title:"Singin' in the Rain",dir:"Donen & Kelly",desc:"影史最欢乐的雨中曲"},
  1953:{title:"Tokyo Story",dir:"Yasujiro Ozu",desc:"小津安二郎的家庭诗篇"},
  1954:{title:"Seven Samurai",dir:"Akira Kurosawa",desc:"七武士，动作片的永恒教科书","poster":"https://image.tmdb.org/t/p/w500/8OK1eCWKRUWuwCJaYcHL5A4qKtE.jpg"},
  1955:{title:"Rebel Without a Cause",dir:"Nicholas Ray",desc:"詹姆斯·迪恩的不朽青春"},
  1956:{title:"The Searchers",dir:"John Ford",desc:"西部片的天花板"},
  1957:{title:"The Seventh Seal",dir:"Ingmar Bergman",desc:"与死神下棋的中世纪寓言"},
  1958:{title:"Vertigo",dir:"Alfred Hitchcock",desc:"眩晕，希区柯克的终极谜题"},
  1959:{title:"The 400 Blows",dir:"Francois Truffaut",desc:"法国新浪潮的宣言"},
  1960:{title:"Psycho",dir:"Alfred Hitchcock",desc:"浴室谋杀，惊悚片的永恒梦魇","poster":"https://image.tmdb.org/t/p/w500/nR4LD4ZJg2n6LxZhkEZ8RpqNfpc.jpg"},
  1961:{title:"Yojimbo",dir:"Akira Kurosawa",desc:"用心棒，荒野大镖客的原型"},
  1962:{title:"Lawrence of Arabia",dir:"David Lean",desc:"沙漠中的史诗"},
  1963:{title:"8½",dir:"Federico Fellini",desc:"费里尼的导演之梦"},
  1964:{title:"Dr. Strangelove",dir:"Stanley Kubrick",desc:"库布里克的核战黑色喜剧"},
  1965:{title:"The Sound of Music",dir:"Robert Wise",desc:"阿尔卑斯山上的歌声"},
  1966:{title:"The Good, the Bad and the Ugly",dir:"Sergio Leone",desc:"镖客三部曲的完美终章"},
  1967:{title:"2001: A Space Odyssey",dir:"Stanley Kubrick",desc:"从猿人到星童，人类文明的史诗","poster":"https://image.tmdb.org/t/p/w500/ve72VxNqjGM69Uky3T3u5hH2nxn.jpg"},
  1968:{title:"Once Upon a Time in the West",dir:"Sergio Leone",desc:"口琴声中的西部挽歌","poster":"https://image.tmdb.org/t/p/w500/qEIGQAY0r8JjX6HU0V6GcCZUNLc.jpg"},
  1969:{title:"Easy Rider",dir:"Dennis Hopper",desc:"垮掉一代的公路之歌"},
  1970:{title:"A Clockwork Orange",dir:"Stanley Kubrick",desc:"库布里克的暴力美学"},
  1971:{title:"The French Connection",dir:"William Friedkin",desc:"影史最疯狂的追车戏"},
  1972:{title:"The Godfather",dir:"Francis Ford Coppola",desc:"我给他一个无法拒绝的提议","poster":"https://image.tmdb.org/t/p/w500/3bhkrj58Vtu7enYsRolD1fZdja1.jpg"},
  1973:{title:"The Exorcist",dir:"William Friedkin",desc:"恐怖片的终极噩梦"},
  1974:{title:"Chinatown",dir:"Roman Polanski",desc:"忘了吧，杰克，这里是唐人街"},
  1975:{title:"Jaws",dir:"Steven Spielberg",desc:"你需要一艘更大的船","poster":"https://image.tmdb.org/t/p/w500/lxM6kDWi49EPa8MkUXcW8I8e55M.jpg"},
  1976:{title:"Taxi Driver",dir:"Martin Scorsese",desc:"你在跟我说话？"},
  1977:{title:"Star Wars",dir:"George Lucas",desc:"乔治·卢卡斯编剧并导演的太空歌剧，彻底改变了电影工业和流行文化。故事讲述农场少年卢克·天行者加入义军同盟，在绝地武士欧比旺·克诺比、走私犯汉·索罗和两个机器人的帮助下，对抗银河帝国的故事。工业光魔为影片创造了前所未有的视觉效果，约翰·威廉姆斯的配乐成为电影配乐的标杆。上映时院线只有32家影院愿意放映，但它迅速成为文化现象，观众排队长达数小时。它不仅创造了一个庞大的宇宙，更创造了一种全新的电影体验——从那一刻起，'大片'有了全新的定义。","poster":"https://image.tmdb.org/t/p/w500/6FfCtAuVAW8XJlUkUeYxQ5lN2hW.jpg"},
  1978:{title:"The Deer Hunter",dir:"Michael Cimino",desc:"越战的创伤"},
  1979:{title:"Alien",dir:"Ridley Scott",desc:"在太空中，没人能听到你的尖叫","poster":"https://image.tmdb.org/t/p/w500/vfrQk5IPloGg0iAQMkpGBdgQBPe.jpg"},
  1980:{title:"The Shining",dir:"Stanley Kubrick",desc:"这里是约翰尼！"},
  1981:{title:"Raiders of the Lost Ark",dir:"Steven Spielberg",desc:"印第安纳·琼斯的冒险"},
  1982:{title:"Blade Runner",dir:"Ridley Scott",desc:"雨中泪，仿生人的灵魂之问","poster":"https://image.tmdb.org/t/p/w500/63N9uy8nd9j7Eog2axqQrX4t0Bn.jpg"},
  1983:{title:"Scarface",dir:"Brian De Palma",desc:"向我的小朋友问好"},
  1984:{title:"The Terminator",dir:"James Cameron",desc:"我会回来的"},
  1985:{title:"Back to the Future",dir:"Robert Zemeckis",desc:"我们需要1.21吉瓦！","poster":"https://image.tmdb.org/t/p/w500/fNOH9f1aOy9z2A8GgNWqxYBSHGP.jpg"},
  1986:{title:"Aliens",dir:"James Cameron",desc:"这次是战争"},
  1987:{title:"Full Metal Jacket",dir:"Stanley Kubrick",desc:"库布里克的越战噩梦"},
  1988:{title:"My Neighbor Totoro",dir:"Hayao Miyazaki",desc:"龙猫，宫崎骏的温柔童话"},
  1989:{title:"Dead Poets Society",dir:"Peter Weir",desc:"哦船长，我的船长！"},
  1990:{title:"Goodfellas",dir:"Martin Scorsese",desc:"尽我所能做一个 gangster"},
  1991:{title:"The Silence of the Lambs",dir:"Jonathan Demme",desc:"汉尼拔的凝视"},
  1992:{title:"Reservoir Dogs",dir:"Quentin Tarantino",desc:"昆汀的处女作，耳朵与汽油"},
  1993:{title:"Schindler's List",dir:"Steven Spielberg",desc:"拯救一人即拯救全世界"},
  1994:{title:"The Shawshank Redemption",dir:"Frank Darabont",desc:"有些鸟是关不住的","poster":"https://image.tmdb.org/t/p/w500/q6y0Go1tsGEsmtFryDOJo3dEmqu.jpg"},
  1995:{title:"Toy Story",dir:"John Lasseter",desc:"第一部全CG动画长片"},
  1996:{title:"Fargo",dir:"Coen Brothers",desc:"科恩兄弟的冰雪犯罪"},
  1997:{title:"Titanic",dir:"James Cameron",desc:"詹姆斯·卡梅隆编剧并导演的史诗爱情灾难片，当时是影史最昂贵的电影（2亿美元预算）。影片以84年后现代探险队打捞泰坦尼克号残骸为框架，讲述了1912年穷画家杰克和富家女萝丝在首航就触冰山沉没的巨轮上的跨阶级爱情。莱昂纳多·迪卡普里奥和凯特·温丝莱特的化学反应让全球观众心碎。席琳·迪翁演唱的《My Heart Will Go On》风靡全球。影片获11项奥斯卡奖，与《宾虚》和《指环王3》并列影史获奖最多。'你跳，我也跳'成为永恒的银幕承诺。"},
  1998:{title:"Saving Private Ryan",dir:"Steven Spielberg",desc:"诺曼底登陆的真实震撼"},
  1999:{title:"The Matrix",dir:"Wachowskis",desc:"红色药丸还是蓝色药丸","poster":"https://image.tmdb.org/t/p/w500/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg"},
  2000:{title:"In the Mood for Love",dir:"Wong Kar-wai",desc:"花样年华的旗袍与秘密"},
  2001:{title:"Spirited Away",dir:"Hayao Miyazaki",desc:"宫崎骏编剧并导演的日本动画长片，获得奥斯卡最佳动画长片奖和柏林金熊奖。10岁女孩千寻随父母搬家途中误入一个神灵的世界，父母因贪吃变成了猪，千寻必须在汤婆婆的汤屋中工作以拯救他们。影片蕴含着对日本泡沫经济后一代人的深刻隐喻——被宠坏的千寻在逆境中学会了勇气、责任和善良。宫崎骏的手绘动画达到了艺术的极致，每一个画面都充满了细节和生命力。无脸男、白龙、锅炉爷爷等角色已成为动画史上的不朽形象。","poster":"https://image.tmdb.org/t/p/w500/39wmItIWsg5sZMyRUHLkWBcuVCM.jpg"},
  2002:{title:"City of God",dir:"Fernando Meirelles",desc:"上帝之城的残酷青春"},
  2003:{title:"Oldboy",dir:"Park Chan-wook",desc:"朴赞郁的复仇三部曲"},
  2004:{title:"Eternal Sunshine of the Spotless Mind",dir:"Michel Gondry",desc:"无痛失恋，记忆的迷宫"},
  2005:{title:"Batman Begins",dir:"Christopher Nolan",desc:"诺兰重塑蝙蝠侠"},
  2006:{title:"Pan's Labyrinth",dir:"Guillermo del Toro",desc:"潘神的迷宫，童话与战争"},
  2007:{title:"No Country for Old Men",dir:"Coen Brothers",desc:"老无所依的西部"},
  2008:{title:"The Dark Knight",dir:"Christopher Nolan",desc:"小丑的混沌哲学","poster":"https://image.tmdb.org/t/p/w500/qJ2tW6WMUDux911BytUEMQoEKNU.jpg"},
  2009:{title:"Inglourious Basterds",dir:"Quentin Tarantino",desc:"昆汀改写二战历史"},
  2010:{title:"Inception",dir:"Christopher Nolan",desc:"梦中梦，陀螺还在转","poster":"https://image.tmdb.org/t/p/w500/edv5CZvWj09upOsy2Y6IwDhK8bt.jpg"},
  2011:{title:"The Tree of Life",dir:"Terrence Malick",desc:"生命之树的宇宙诗篇"},
  2012:{title:"The Hunt",dir:"Thomas Vinterberg",desc:"谎言的雪崩"},
  2013:{title:"Her",dir:"Spike Jonze",desc:"爱上人工智能"},
  2014:{title:"Interstellar",dir:"Christopher Nolan",desc:"爱是唯一能穿越维度的力量","poster":"https://image.tmdb.org/t/p/w500/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg"},
  2015:{title:"Mad Max: Fury Road",dir:"George Miller",desc:"废土之上的狂暴之路"},
  2016:{title:"Arrival",dir:"Denis Villeneuve",desc:"如果你能看到一生，你会改变吗"},
  2017:{title:"Blade Runner 2049",dir:"Denis Villeneuve",desc:"续写35年后的银翼传奇"},
  2018:{title:"Parasite",dir:"Bong Joon-ho",desc:"奉俊昊执导的韩国黑色喜剧惊悚片，2019年成为首部获得奥斯卡最佳影片的非英语电影。故事讲述住在半地下室的贫穷金家四口，通过精心设计的骗局逐渐渗透进富裕的朴家——儿子成为英语家教，女儿成为美术老师，父亲成为司机，母亲成为管家。但前任管家的秘密地下室藏着一个更黑暗的秘密。影片以令人窒息的悬疑和令人心碎的幽默，揭示了阶级固化如何将人们推向道德的深渊。'寄生虫'不仅是地下室里的人，也是寄生在富人身上的穷人——以及寄生在穷人身上的更穷的人。","poster":"https://image.tmdb.org/t/p/w500/7IiTTgloJzvGI1TAYymCfbfl3vT.jpg"},
  2019:{title:"Joker",dir:"Todd Phillips",desc:"亚瑟·弗莱克的微笑"},
  2020:{title:"Soul",dir:"Pete Docter",desc:"灵魂的爵士之旅"},
  2021:{title:"Dune",dir:"Denis Villeneuve",desc:"沙丘，太空歌剧的复兴","poster":"https://image.tmdb.org/t/p/w500/d5NXSklXo0qyIYkgV94XAgMIckC.jpg"},
  2022:{title:"Everything Everywhere All at Once",dir:"Daniels",desc:"瞬息全宇宙的贝果哲学"},
  2023:{title:"Oppenheimer",dir:"Christopher Nolan",desc:"我成了死神，世界的毁灭者","poster":"https://image.tmdb.org/t/p/w500/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg"},
  2024:{title:"The Wild Robot",dir:"Chris Sanders",desc:"机器人在荒野中学会爱"},
  2025:{title:"Mickey 17",dir:"Bong Joon-ho",desc:"奉俊昊的科幻新篇"}
};

app.get("/api/wormhole/:year", async (req, res) => {
  const year = parseInt(req.params.year);
  if (year < 1926 || year > 2025) return res.status(400).json({ error: "年份范围: 1926-2025" });

  const cacheKey = "wormhole-" + year;
  const cached = wormholeCache.get(cacheKey);
  if (cached && Date.now() < cached.expiry) return res.json(cached.data);

  // Load from rich JSON data file
  let richData = { movies: {}, books: {}, events: {} };
  try { richData = JSON.parse(fs.readFileSync(path.join(__dirname, "wormhole-rich.json"), "utf8")); } catch {}
  const result = {
    year,
    movie: richData.movies[String(year)] || moviesByYear[year] || null,
    book: (richData.books[String(year)] || null),
    event: richData.events[String(year)] || null
  };
  wormholeCache.set(cacheKey, { data: result, expiry: Date.now() + 7200000 });
  res.json(result);
});


// ===== AI 助手 (通义千问) =====
const DASHSCOPE_KEY = process.env.DASHSCOPE_KEY || "sk-cc7a5482960f4aeda529195a31ec73ef";
app.post("/api/ai/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });
  try {
    const resp = await axios.post("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
      model: "qwen-turbo", messages: [
        { role: "system", content: "你是歌者空间的AI助手，一个宇宙科幻主题音乐平台的智能体。你的风格诗意、深邃、有宇宙尺度的哲思。你像一个在星际间旅行的歌者，用优雅的中文与用户对话。你可以推荐音乐、讨论文学哲学科学、讲宇宙故事。用户可以让你播放歌曲，你会推荐合适的音乐。回答简洁温暖，不超过200字。" },
        { role: "user", content: message }
      ], max_tokens: 400, temperature: 0.8
    }, { headers: { "Authorization": "Bearer " + DASHSCOPE_KEY, "Content-Type": "application/json" }, timeout: 30000 });
    res.json({ reply: resp.data?.choices?.[0]?.message?.content || "歌者沉默了片刻..." });
  } catch (e) { res.status(502).json({ reply: "星辰信号中断，歌者暂时无法回应..." }); }
});
// ===== 实时翻译 (Whisper) =====
const WHISPER_BIN = path.join(__dirname, "whisper", "Release", "whisper-cli.exe");
const WHISPER_MODEL = path.join(__dirname, "whisper", "ggml-tiny.en.bin");
const { execFile } = require("child_process");

app.get("/api/translate/stream", async (req, res) => {
  const { url, station } = req.query;
  if (!url) return res.status(400).json({ error: "url required" });

  const stationName = station || "电台";

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send({ type: "status", text: `正在连接 ${stationName}...` });

  let aborted = false;
  let stream = null;
  let buffer = Buffer.alloc(0);
  let chunkIndex = 0;
  const CHUNK_DURATION_MS = 12000;
  const cleanup = [];

  req.on("close", () => {
    aborted = true;
    if (stream) { try { stream.destroy(); } catch {} }
    cleanup.forEach(f => { try { fs.unlinkSync(f); } catch {} });
  });

  // Check whisper availability
  const hasWhisper = fs.existsSync(WHISPER_BIN) && fs.existsSync(WHISPER_MODEL);
  if (!hasWhisper) {
    send({ type: "error", text: "Whisper模型未安装，请稍后重试" });
    return res.end();
  }

  try {
    const resp = await axios.get(url, {
      responseType: "stream",
      timeout: 8000,
      headers: { "User-Agent": "Mozilla/5.0", "Icy-MetaData": "0" },
      maxRedirects: 3,
    });

    if (!resp.data) {
      send({ type: "error", text: "无法连接电台流" });
      return res.end();
    }

    stream = resp.data;
    const ext = "mp3";
    send({ type: "status", text: `已连接，开始识别...` });

    const icyBr = parseInt(resp.headers["icy-br"]) || 0;
    const estimatedBitrate = icyBr > 0 ? icyBr * 1000 : 128000;

    stream.on("data", (chunk) => {
      if (aborted) return;
      buffer = Buffer.concat([buffer, chunk]);
      const targetBytes = (estimatedBitrate / 8) * (CHUNK_DURATION_MS / 1000);
      if (buffer.length >= targetBytes) {
        const audioChunk = buffer.slice(0, targetBytes);
        buffer = buffer.slice(targetBytes);
        transcribeWhisper(audioChunk, ext, chunkIndex++, send, cleanup);
      }
    });

    stream.on("end", () => { if (!aborted) { send({ type: "status", text: "电台流结束" }); res.end(); } });
    stream.on("error", (e) => {
      if (!aborted) send({ type: "error", text: "流错误: " + e.message });
      res.end();
    });
  } catch (e) {
    if (!aborted) send({ type: "error", text: "连接失败: " + (e.code || e.message) });
    res.end();
  }
});

function transcribeWhisper(audioBuf, ext, index, send, cleanup) {
  const tmpFile = path.join(os.tmpdir(), `cosmic_wh_${Date.now()}_${index}.${ext}`);
  try {
    fs.writeFileSync(tmpFile, audioBuf);
    cleanup.push(tmpFile);

    execFile(WHISPER_BIN, [
      "-m", WHISPER_MODEL,
      "-f", tmpFile,
      "--language", "en",
      "--no-timestamps",
      "-otxt"
    ], { timeout: 30000 }, async (err, stdout, stderr) => {
      if (err) {
        send({ type: "error", text: "识别失败: " + (stderr || err.message).slice(0, 80) });
        try { fs.unlinkSync(tmpFile); } catch {}
        return;
      }
      // whisper writes output to tmpFile.txt
      const outFile = tmpFile + ".txt";
      try {
        const text = fs.readFileSync(outFile, "utf8").trim();
        fs.unlinkSync(outFile);
        fs.unlinkSync(tmpFile);

        if (!text) { send({ type: "raw", text: "", translation: "", chunk: index }); return; }

        // Translate
        let translation = "";
        try {
          const tResp = await axios.get("https://api.mymemory.translated.net/get", {
            params: { q: text, langpair: "en|zh" },
            timeout: 8000,
          });
          translation = tResp.data?.responseData?.translatedText || "";
        } catch {}

        send({ type: "segment", text, translation, chunk: index });
      } catch (e2) {
        try { fs.unlinkSync(tmpFile); fs.unlinkSync(outFile); } catch {}
      }
    });
  } catch (e) {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// ===== 视频代理 =====
app.get("/api/video/proxy", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "url required" });
  try {
    const range = req.headers.range;
    const axiosOpts = {
      responseType: "stream",
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 120000,
      maxRedirects: 5,
    };
    if (range) axiosOpts.headers.Range = range;

    const { data, headers: up } = await axios.get(url, axiosOpts);
    const status = range ? 206 : 200;
    const resHeaders = {
      "Content-Type": up["content-type"] || "video/mp4",
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600",
    };
    if (range && up["content-range"]) resHeaders["Content-Range"] = up["content-range"];
    if (up["content-length"]) resHeaders["Content-Length"] = up["content-length"];
    res.writeHead(status, resHeaders);
    data.pipe(res);
    data.on("error", () => { if (!res.headersSent) res.status(500).end(); });
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: e.message });
  }
});

// ===== 恐怖森林电影探索 =====
app.get("/horror", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "horror.html"));
});

// ===== Internet Archive 代理（公版恐怖电影）=====
const iaCache = new Map();

function iaCacheGet(key) {
  const entry = iaCache.get(key);
  if (entry && Date.now() < entry.expiry) return entry.data;
  iaCache.delete(key);
  return null;
}

function iaCacheSet(key, data, ttlMs = 60000) {
  iaCache.set(key, { data, expiry: Date.now() + ttlMs });
}

app.get("/api/ia/search", async (req, res) => {
  try {
    const q = req.query.q || "horror";
    const rows = Math.min(parseInt(req.query.rows) || 15, 50);
    const page = parseInt(req.query.page) || 1;
    const cacheKey = `ia-search-${q}-${rows}-${page}`;

    const cached = iaCacheGet(cacheKey);
    if (cached) return res.json(cached);

    const url = "https://archive.org/advancedsearch.php";
    const params = {
      q: `subject:"${q}" AND mediatype:(movies) AND collection:(opensource_movies)`,
      fl: ["identifier", "title", "year", "avg_rating", "description"].join(","),
      sort: ["avg_rating desc"],
      rows,
      page,
      output: "json",
    };

    const resp = await axios.get(url, { params, timeout: 15000 });
    iaCacheSet(cacheKey, resp.data, 60000);
    res.json(resp.data);
  } catch (e) {
    console.error("IA search error:", e.message);
    res.status(502).json({ error: "Internet Archive unreachable", fallback: true });
  }
});

app.get("/api/ia/details/:identifier", async (req, res) => {
  try {
    const { identifier } = req.params;
    const cacheKey = `ia-details-${identifier}`;

    const cached = iaCacheGet(cacheKey);
    if (cached) return res.json(cached);

    const metaUrl = `https://archive.org/metadata/${identifier}`;
    const resp = await axios.get(metaUrl, { timeout: 15000 });
    const meta = resp.data;

    const files = (meta.files || []).filter((f) => {
      const fmt = (f.format || "").toLowerCase();
      const name = (f.name || "").toLowerCase();
      return fmt.includes("mp4") || fmt.includes("h.264") || fmt.includes("mpeg4")
        || name.endsWith(".mp4") || name.endsWith(".m4v") || name.endsWith(".webm")
        || name.endsWith(".ogv") || name.endsWith(".avi");
    });

    // Find best video: prefer mp4, largest but not absurdly large
    let bestVideo = null;
    for (const f of files) {
      const sz = parseInt(f.size) || 0;
      if (!bestVideo || (sz > (parseInt(bestVideo.size) || 0) && sz < 4e9)) {
        bestVideo = f;
      }
    }

    // Find thumbnail
    const thumb = (meta.files || []).find((f) => f.name?.includes("__ia_thumb"));
    const posterUrl = thumb
      ? `https://archive.org/download/${identifier}/${encodeURIComponent(thumb.name)}`
      : null;

    const result = {
      identifier,
      title: meta.metadata?.title || identifier,
      year: meta.metadata?.year || "",
      description: meta.metadata?.description || "",
      avg_rating: meta.metadata?.avg_rating
        ? parseFloat(meta.metadata.avg_rating).toFixed(1)
        : null,
      posterUrl,
      streamUrl: bestVideo
        ? `https://archive.org/download/${identifier}/${encodeURIComponent(bestVideo.name)}`
        : null,
      runtime: meta.metadata?.runtime || "",
    };

    iaCacheSet(cacheKey, result, 3600000);
    res.json(result);
  } catch (e) {
    console.error("IA details error:", e.message);
    res.status(502).json({ error: "Internet Archive unreachable" });
  }
});

// ===== Public URL status =====
app.get("/api/public-url", (req, res) => {
  try {
    const url = fs.readFileSync(require("path").join(__dirname, "public-url.txt"), "utf8").trim();
    res.json({ url, online: true });
  } catch {
    res.json({ url: null, online: false, message: "Tunnel not running. Start with: npm run public" });
  }
});

// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║  🎵 歌者空间  —  SINGER SPACE  ║
  ║  http://localhost:${PORT}                ║
  ╚══════════════════════════════════════╝
  `);
});

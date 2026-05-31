// 歌者空间 — Cloudflare Tunnel Daemon
// Auto-reconnect with URL persistence. Run: node tunnel-daemon.js
// Requires: server already running on port 3000

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const URL_FILE = path.join(__dirname, "public-url.txt");
const CLOUDFLARED = path.join(__dirname, "cloudflared.exe");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  console.log(`[${ts}] ${msg}`);
}

function saveUrl(url) {
  try {
    fs.writeFileSync(URL_FILE, url + "\n");
    log(`URL saved → ${URL_FILE}`);
  } catch (e) {
    log(`Save failed: ${e.message}`);
  }
}

function getSavedUrl() {
  try {
    if (fs.existsSync(URL_FILE)) {
      return fs.readFileSync(URL_FILE, "utf8").trim();
    }
  } catch {}
  return null;
}

async function startTunnel() {
  log("Starting Cloudflare Tunnel...");

  const proc = spawn(CLOUDFLARED, [
    "tunnel",
    "--url", "http://localhost:3000/horror",
    "--protocol", "quic",
    "--no-autoupdate",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let urlFound = false;

  function tryExtractUrl(text, dest) {
    process[dest].write(text);
    if (urlFound) return;
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match) {
      urlFound = true;
      const url = match[0];
      log(`\n╔══════════════════════════════════════════════════════╗`);
      log(`║  🌌 PUBLIC URL: ${url}`);
      log(`╚══════════════════════════════════════════════════════╝`);
      saveUrl(url);
    }
  }

  proc.stdout.on("data", (data) => tryExtractUrl(data.toString(), "stdout"));
  proc.stderr.on("data", (data) => tryExtractUrl(data.toString(), "stderr"));

  return new Promise((resolve) => {
    proc.on("exit", (code) => {
      log(`Tunnel exited (code ${code}), reconnecting in 5s...`);
      resolve();
    });
    proc.on("error", (err) => {
      log(`Tunnel error: ${err.message}, reconnecting in 10s...`);
      resolve();
    });
  });
}

async function main() {
  log("歌者空间 — Tunnel Daemon");
  log("==============================");

  const saved = getSavedUrl();
  if (saved) log(`Last known URL: ${saved}`);

  while (true) {
    try {
      await startTunnel();
    } catch (e) {
      log(`Unexpected: ${e.message}`);
    }
    await sleep(5000);
  }
}

process.on("SIGINT", () => {
  log("Shutting down...");
  process.exit(0);
});

process.on("uncaughtException", (e) => {
  log(`Error: ${e.message}`);
});

main();

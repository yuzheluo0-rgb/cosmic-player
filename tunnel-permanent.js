const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const CLOUDFLARED = path.join(__dirname, "cloudflared.exe");
const TOKEN = "eyJhIjoiNGIxYTE1MWQ3MTVkNTAxMzFjOTEzNTNmMjAxMDhkYmEiLCJ0IjoiMDQ2MzRkNzQtMzY2OC00OTE3LTg2M2UtNDA1M2VlYTgwMWY1IiwicyI6Ik5XVTBNekJrTXpBdE1tWXlZaTAwT0RJNExXSm1NREl0TmpWbE1tTXlPVFpsWmpCayJ9";

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString("zh-CN",{hour12:false})}] ${msg}`);
}

async function start() {
  log("Starting permanent tunnel → singer-space.lat");
  const proc = spawn(CLOUDFLARED, ["tunnel", "run", "--token", TOKEN], { stdio: ["ignore","pipe","pipe"], windowsHide: true });
  proc.stdout.on("data", d => process.stdout.write(d));
  proc.stderr.on("data", d => process.stderr.write(d));
  return new Promise(r => { proc.on("exit", code => { log(`Tunnel exited (${code}), restart in 5s`); r(); }); proc.on("error", e => { log(`Error: ${e.message}`); r(); }); });
}

async function main() {
  while(true) { try { await start(); } catch(e) { log(`Unexpected: ${e.message}`); } await new Promise(r => setTimeout(r, 5000)); }
}
main();

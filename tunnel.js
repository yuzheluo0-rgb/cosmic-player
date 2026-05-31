const lt = require("localtunnel");
const http = require("http");

let lastUrl = null;

async function connect() {
  try {
    const tunnel = await lt({ port: 3000 });
    lastUrl = tunnel.url;
    console.log("TUNNEL=" + tunnel.url);

    const keepalive = setInterval(() => {
      http.get("http://localhost:3000/", (res) => {
        // ok - just keep the event loop alive
      }).on("error", () => {});
    }, 15000);

    tunnel.on("close", () => {
      console.log("Tunnel closed, reconnecting in 5s...");
      clearInterval(keepalive);
      setTimeout(connect, 5000);
    });

    tunnel.on("error", (err) => {
      console.log("Tunnel error:", err.message);
    });
  } catch (e) {
    console.log("Connect failed, retrying in 10s:", e.message);
    setTimeout(connect, 10000);
  }
}

connect();
process.on("uncaughtException", (e) => console.log("Error:", e.message));

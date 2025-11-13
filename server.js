// server.js
const express = require("express");
const http = require("http");
const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");
const socketIO = require("socket.io");
const schedule = require("node-schedule");
const cors = require("cors");
const path = require("path");
const { platform } = require("os");

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(cors());
app.use(express.json());

// serve static frontend from 'public' folder
app.use(express.static(path.join(__dirname, "public")));


app.get("/", (req, res)=>{
    res.sendFile(path.join(__dirname, "index.html"));
})

let client; // make client re-creatable

function initWhatsAppClient() {
  console.log("⚙️ Initializing WhatsApp client...");

  client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: true }
  });

  client.on("qr", async (qr) => {
    try {
      const qrDataUrl = await QRCode.toDataURL(qr);
      io.emit("qr", qrDataUrl);
      io.emit("status", "QR_RECEIVED");
      console.log("📲 QR generated and emitted.");
    } catch (err) {
      console.error("QR generation error:", err);
    }
  });

  client.on("authenticated", () => {
    console.log("✅ Authenticated!");
    io.emit("status", "AUTHENTICATED");
  });

  client.on("ready", () => {
    console.log("💬 WhatsApp client ready!");
    io.emit("status", "READY");

    const name = client.info.pushname;
    const mobileNumber = client.info.wid.user;

    io.emit("userInfo", { name: name, number: mobileNumber, platform: client.info.platform });
  });

  client.on("auth_failure", (msg) => {
    console.log("❌ Auth failure:", msg);
    io.emit("status", "AUTH_FAILURE");
  });

  client.on("disconnected", (reason) => {
    console.log("🔌 WhatsApp disconnected:", reason);
    io.emit("status", "DISCONNECTED");
  });

  client.initialize();
}


// simple web socket connection logs
io.on("connection", (socket) => {
  console.log("Client connected to socket.io");
  socket.on("disconnect", () => console.log("Socket disconnected"));
});

// Re-initialize WhatsApp client manually
app.post("/link", async (req, res) => {
  try {
    if (client) {
      await client.destroy(); // safely close old instance if exists
    }
    initWhatsAppClient(); // create new instance and emit fresh QR
    console.log("♻️ Reinitializing WhatsApp client...");
    res.json({ success: true, msg: "New QR generated. Scan to link WhatsApp." });
  } catch (err) {
    console.error("Error reinitializing:", err);
    res.status(500).json({ success: false, msg: "Failed to reinitialize client." });
  }
});

// Logout from WhatsApp session
app.post("/logout", async (req, res) => {
  try {
    await client.logout();
    console.log("👋 Logged out from WhatsApp session.");
    io.emit("status", "DISCONNECTED");
    res.json({ success: true, msg: "Logged out successfully" });
  } catch (err) {
    console.error("Logout error:", err);
    res.status(500).json({ success: false, msg: "Logout failed" });
  }
});


// schedule endpoint
app.post("/schedule", async (req, res) => {
  const { number, message, time } = req.body;
  if (!number || !message || !time) {
    return res.status(400).json({ success: false, error: "number, message and time are required" });
  }

  // ensure correct WhatsApp chat id format (international number, no +)
  // e.g. 919876543210 => 919876543210@c.us
  const chatId = `${number.replace(/\D/g, "")}@c.us`;
  const date = new Date(time);

  if (isNaN(date.getTime())) {
    return res.status(400).json({ success: false, error: "Invalid time format" });
  }

  schedule.scheduleJob(date, async () => {
    try {
      await client.sendMessage(chatId, message);
      console.log(`Sent scheduled message to ${number} at ${new Date().toISOString()}`);
    } catch (err) {
      console.error("Failed to send scheduled message:", err);
    }
  });

  return res.json({ success: true, msg: `Message scheduled for ${date.toString()}` });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

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
const fs = require("fs");
const SCHEDULES_FILE = path.join(__dirname, "schedules.json");

// Load schedules
let schedules = [];
if (fs.existsSync(SCHEDULES_FILE)) {
    try {
        schedules = JSON.parse(fs.readFileSync(SCHEDULES_FILE, "utf8"));
    } catch {
        schedules = [];
    }
}

// helper to persist
function saveSchedules() {
    // store only serializable data
    const cleanData = schedules.map(({ number, message, time, repeat }) => ({
        number,
        message,
        time,
        repeat
    }));

    fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(cleanData, null, 2));
}

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(cors());
app.use(express.json());

// serve static frontend from 'public' folder
app.use(express.static(path.join(__dirname, "public")));


app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
})

app.get("/schedules", (req, res) => {
    const cleanList = schedules.map(({ number, message, time, repeat }) => ({
        number,
        message,
        time,
        repeat
    }));
    res.json({ schedules: cleanList });
});


app.delete("/schedule/:number", (req, res) => {
    const { number } = req.params;
    const idx = schedules.findIndex(s => s.number === number);
    if (idx === -1) return res.status(404).json({ success: false, msg: "Schedule not found" });

    const [removed] = schedules.splice(idx, 1);
    if (removed.job) removed.job.cancel();

    saveSchedules();
    res.json({ success: true, msg: `Deleted schedule for ${number}` });
});




let client; // make client re-creatable

function initWhatsAppClient() {
    console.log("⚙️ Initializing WhatsApp client...");

    client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            headless: true,
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--single-process",
                "--no-zygote",
                "--disable-accelerated-2d-canvas",
                "--no-first-run"
            ]
        }
    });

    client.on("qr", async (qr) => {
        try {
            const qrDataUrl = await QRCode.toDataURL(qr);
            io.emit("qr", qrDataUrl);
            io.emit("status", { state: "QR_RECEIVED" });
            console.log("📲 QR generated and emitted.");
        } catch (err) {
            console.error("QR generation error:", err);
        }
    });

    client.on("auth_attempt", () => {
        console.log("🔐 Authentication handshake started!");
        // You can trigger your function here
        // yourCustomFunction();
    });

    client.on("change_state", (state) => {
        if (state === "CONNECTING") {
            console.log("📡 QR scanned — handshake started!");
            showLoadingUI();
        }
    });

    client.on("authenticated", () => {
        console.log("✅ Authenticated!");
        io.emit("status", { state: "AUTHENTICATED" });
    });

    client.on("ready", () => {
        console.log("💬 WhatsApp client ready!");
        io.emit("status", { state: "READY" });

        const name = client.info.pushname;
        const mobileNumber = client.info.wid.user;

        io.emit("userInfo", { state: "READY", name: name, number: mobileNumber, platform: client.info.platform });
    });

    client.on("auth_failure", (msg) => {
        console.log("❌ Auth failure:", msg);
        io.emit("status", { state: "AUTH_FAILURE" });
    });

    client.on("disconnected", (reason) => {
        console.log("🔌 WhatsApp disconnected:", reason);
        io.emit("status", { state: "DISCONNECTED" });
    });

    client.initialize();
}

initWhatsAppClient();


// simple web socket connection logs
io.on("connection", (socket) => {
    console.log("Client connected to socket.io");

    // Wrap async code in an IIFE
    (async () => {
        try {
            if (client?.info) {
                const state = await client.getState();
                const name = client?.info?.pushname;
                const mobileNumber = client?.info?.wid?.user;

                io.emit("userInfo", { state: state, name: name, number: mobileNumber, platform: client?.info?.platform });
            } else {
                io.emit("userInfo", {});
            }
        } catch (err) {
            console.error("Error getting client state");
            io.emit("userInfo", {});
        }
    })();

    socket.on("disconnect", () => console.log("Socket disconnected"));
});


app.get("/server-time", (req, res) => {
    res.send({
        serverTime: new Date().toString(),
        serverISOString: new Date().toISOString()
    });
});


// Re-initialize WhatsApp client manually
app.post("/link", async (req, res) => {
    try {
        if (client?.info) {
            await client.destroy(); // safely close old instance if exists
        }
        initWhatsAppClient(); // create new instance and emit fresh QR
      
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
        io.emit("status", { state: "DISCONNECTED" });
        res.json({ success: true, msg: "Logged out successfully" });
    } catch (err) {
        console.error("Logout error:", err);
        res.status(500).json({ success: false, msg: "Logout failed" });
    }
});


// schedule endpoint
// schedule endpoint (create/update)
app.post("/schedule", async (req, res) => {
    const { number, message, time, timezone, repeat = "once" } = req.body;
    console.log(time, timezone);
    if (!number || !message || !time || !timezone)
        return res.status(400).json({ success: false, error: "number, message and time are required" });

    const chatId = `${number.replace(/\D/g, "")}@c.us`;
    const date = new Date(time).toISOString();
    console.log(date)
    if (isNaN(date.getTime()))
        return res.status(400).json({ success: false, error: "Invalid time format" });

    // if already scheduled for this number, cancel old one
    const existing = schedules.find(s => s.number === number);
    if (existing && existing.job) {
        existing.job.cancel();
        schedules = schedules.filter(s => s.number !== number);
    }

    // schedule job
    let job;
    if (repeat === "daily") {
        const cronExp = `${date.getMinutes()} ${date.getHours()} * * *`;
        job = schedule.scheduleJob({ rule: cronExp, tz: timezone }, async () => {
            try {
                await client.sendMessage(chatId, message);
                console.log(`Daily message sent to ${number}`);
            } catch (err) {
                console.error("Failed daily send:", err);
            }
        });
    } else {
        job = schedule.scheduleJob(date, async () => {
            try {
                await client.sendMessage(chatId, message);
                console.log(`One-time message sent to ${number}`);
            } catch (err) {
                console.error("Failed one-time send:", err);
            }
        });
    }

    // store job info safely (without circular refs)
    schedules.push({ number, message, time, repeat, job });
    saveSchedules();

    res.json({ success: true, msg: `Message scheduled (${repeat})`, total: schedules.length });
});




// Restore schedules on startup
schedules.forEach(s => {
    const chatId = `${s.number.replace(/\D/g, "")}@c.us`;
    const date = new Date(s.time);

    if (s.repeat === "daily") {
        const hours = date.getHours();
        const minutes = date.getMinutes();
        const cronExp = `${minutes} ${hours} * * *`;
        s.job = schedule.scheduleJob({ rule: cronExp, tz: "Asia/Kolkata" }, async () => {
            await client.sendMessage(chatId, s.message);
            console.log(`Restored daily message sent to ${s.number}`);
        });
    } else if (date > new Date()) {
        s.job = schedule.scheduleJob(date, async () => {
            await client.sendMessage(chatId, s.message);
            console.log(`Restored one-time message sent to ${s.number}`);
        });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

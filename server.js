/**
 * RealMsg — Production Server
 * Stack : Express + Socket.IO
 * Host  : Render.com (realmsg.onrender.com)
 * Rooms : in-memory, no DB needed
 */

const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");
const cors    = require("cors");
const path    = require("path");

const PORT        = process.env.PORT || 3000;
const MAX_HISTORY = 5;

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout:  25000,
  pingInterval: 10000,
  // Allow WebSocket + long-polling fallback for Render's proxy
  transports: ["websocket", "polling"],
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── In-memory state ────────────────────────────────────────────────────────
const rooms = new Map();
// rooms: Map<roomCode, { messages: MsgObj[], createdAt: number }>

function getRoom(code) {
  if (!rooms.has(code)) rooms.set(code, { messages: [], createdAt: Date.now() });
  return rooms.get(code);
}

function addMessage(code, msg) {
  const room = getRoom(code);
  room.messages.push(msg);
  if (room.messages.length > MAX_HISTORY) room.messages.shift();
}

function sanitize(code) {
  return (code || "").toString().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
}

// ── REST ───────────────────────────────────────────────────────────────────

// Keep-alive ping — Render free tier sleeps after 15 min inactivity
// receiver.html pings this every 4 minutes to keep server warm
app.get("/ping", (_, res) => res.json({ ok: true, ts: Date.now() }));

// Health check
app.get("/health", (_, res) => res.json({
  ok: true,
  rooms: rooms.size,
  uptime: Math.floor(process.uptime()),
  ts: new Date().toISOString(),
}));

// Page routes
app.get("/sender",   (_, res) => res.sendFile(path.join(__dirname, "public", "sender.html")));
app.get("/receiver", (_, res) => res.sendFile(path.join(__dirname, "public", "receiver.html")));

// ── Socket.IO ──────────────────────────────────────────────────────────────
io.on("connection", (socket) => {

  // ── Join room (both sender and receiver call this) ─────────────────
  socket.on("join-room", ({ room }) => {
    const code = sanitize(room);
    if (!code) return;
    socket.join(code);
    // Send existing history to the joiner immediately
    socket.emit("history", getRoom(code).messages);
  });

  // ── Send message ───────────────────────────────────────────────────
  socket.on("send-message", ({ room, text }) => {
    const code = sanitize(room);
    if (!code || !text || !text.trim()) return;

    const msg = {
      id:   Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      text: text.trim().slice(0, 1000),
      ts:   new Date().toISOString(),
    };

    addMessage(code, msg);
    // Push to ALL sockets in the room instantly
    io.to(code).emit("new-message", msg);
  });

  // ── Clear room ────────────────────────────────────────────────────
  socket.on("clear-room", ({ room }) => {
    const code = sanitize(room);
    if (!code) return;
    if (rooms.has(code)) rooms.get(code).messages = [];
    io.to(code).emit("cleared");
  });

  // ── Signal: GO / STOP ─────────────────────────────────────────────
  // type 'go'   → green circle on receiver (start reading)
  // type 'stop' → red circle on receiver   (stop reading)
  socket.on("signal", ({ room, type }) => {
    const code = sanitize(room);
    if (!code) return;
    if (type !== "go" && type !== "stop") return;
    io.to(code).emit("signal", { type });
  });

});

// ── Start ──────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`RealMsg running → http://localhost:${PORT}`);
  console.log(`  Sender  : http://localhost:${PORT}/sender`);
  console.log(`  Receiver: http://localhost:${PORT}/receiver`);
  console.log(`  Health  : http://localhost:${PORT}/health`);
});

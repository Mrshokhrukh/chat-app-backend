import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import User from './models/User.js';
import Message from './models/Message.js';
import DmMessage from './models/DmMessage.js';

const PORT       = process.env.PORT       || 3001;
const MONGO_URL  = process.env.MONGO_URL  || 'mongodb://localhost:27017/chatapp';
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';

const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'https://chat-app-two-steel-34.vercel.app',
  process.env.CLIENT_URL,
].filter(Boolean);

const COLORS = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#e91e63'];

// ── MongoDB ────────────────────────────────────────────────────────
try {
  await mongoose.connect(MONGO_URL);
  console.log(`✅ MongoDB: ${MONGO_URL}`);
} catch (e) {
  console.error('❌ MongoDB ga ulanib bolmadi:', e.message);
  process.exit(1);
}

const savedRooms = await Message.distinct('room');
const rooms = new Set(['general', 'random', ...savedRooms]);

// ── Express + Socket.IO ────────────────────────────────────────────
const app = express();
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json());

app.get('/health', (_, res) => res.json({ status: 'ok', uptime: process.uptime() }));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'], credentials: true },
});

const onlineUsers = {}; // socketId -> { username, color }
const roomTyping  = {}; // roomId   -> Set<socketId>

// ── Auth middleware ────────────────────────────────────────────────
io.use(async (socket, next) => {
  const { token, username, phone } = socket.handshake.auth;

  if (token) {
    try {
      const { userId } = jwt.verify(token, JWT_SECRET);
      const user = await User.findById(userId).lean();
      if (user) { socket.userData = user; return next(); }
    } catch {}
    return next(new Error('AUTH_EXPIRED'));
  }

  if (username?.trim() && phone?.trim()) {
    try {
      let user = await User.findOne({ phone: phone.trim() });
      if (!user) {
        const count = await User.countDocuments();
        user = await User.create({
          username: username.trim(),
          phone:    phone.trim(),
          color:    COLORS[count % COLORS.length],
        });
      }
      socket.userData = user.toObject();
      socket.newToken = jwt.sign({ userId: user._id }, JWT_SECRET);
      return next();
    } catch (e) {
      console.error('Auth xato:', e.message);
      return next(new Error('AUTH_FAILED'));
    }
  }

  return next(new Error('AUTH_REQUIRED'));
});

// ── Connection ─────────────────────────────────────────────────────
io.on('connection', async (socket) => {
  const { username, color } = socket.userData;
  onlineUsers[socket.id] = { username, color };

  if (socket.newToken) socket.emit('new_token', socket.newToken);

  socket.join('general');

  try {
    const history = await Message.find({ room: 'general' })
      .sort({ createdAt: -1 }).limit(50).lean();

    socket.emit('init', {
      username,
      myColor: color,
      rooms:   [...rooms],
      history: history.reverse().map(toClient),
      users:   Object.values(onlineUsers),
    });
  } catch (e) { console.error(e); }

  io.emit('users', Object.values(onlineUsers));
  emitSys('general', `${username} chatga kirdi`);

  // ── Xonalar ────────────────────────────────────────────────
  socket.on('join_room', async (roomId) => {
    if (!rooms.has(roomId)) return;
    socket.join(roomId);
    try {
      const history = await Message.find({ room: roomId })
        .sort({ createdAt: -1 }).limit(50).lean();
      socket.emit('room_history', { room: roomId, messages: history.reverse().map(toClient) });
    } catch (e) { console.error(e); }
  });

  socket.on('create_room', (name) => {
    const id = name.toLowerCase().trim().replace(/\s+/g, '-');
    if (!id) return;
    rooms.add(id);
    socket.join(id);
    io.emit('room_created', id);
    socket.emit('room_created_ack', id);
    socket.emit('room_history', { room: id, messages: [] });
  });

  // ── Xabarlar ───────────────────────────────────────────────
  socket.on('message', async ({ room, text }) => {
    if (!rooms.has(room)) return;
    try {
      const msg = await Message.create({
        room, type: 'user', username, color, text: text.trim(), time: now(),
      });
      io.to(room).emit('message', toClient(msg));
    } catch (e) { console.error(e); }
  });

  // ── DM ─────────────────────────────────────────────────────
  socket.on('private_message', async ({ to, text }) => {
    try {
      const dm = await DmMessage.create({
        from: username, fromColor: color, to, text: text.trim(), time: now(),
      });
      const msg = dmToClient(dm);
      socket.emit('private_message', msg);
      const recvId = findSocket(to, socket.id);
      if (recvId) io.to(recvId).emit('private_message', msg);
    } catch (e) { console.error(e); }
  });

  socket.on('get_dm_history', async (other) => {
    try {
      const msgs = await DmMessage.find({
        $or: [{ from: username, to: other }, { from: other, to: username }],
      }).sort({ createdAt: 1 }).limit(100).lean();
      socket.emit('dm_history', { with: other, messages: msgs.map(dmToClient) });
    } catch (e) { console.error(e); }
  });

  // ── Typing ─────────────────────────────────────────────────
  socket.on('typing_start', (room) => {
    if (!roomTyping[room]) roomTyping[room] = new Set();
    roomTyping[room].add(socket.id);
    socket.to(room).emit('typing', { room, users: typers(room) });
  });

  socket.on('typing_stop', (room) => {
    roomTyping[room]?.delete(socket.id);
    socket.to(room).emit('typing', { room, users: typers(room) });
  });

  socket.on('dm_typing_start', (to) => {
    const id = findSocket(to, socket.id);
    if (id) io.to(id).emit('dm_typing', { from: username });
  });

  socket.on('dm_typing_stop', (to) => {
    const id = findSocket(to, socket.id);
    if (id) io.to(id).emit('dm_stopped_typing', { from: username });
  });

  // ── Reaksiyalar ────────────────────────────────────────────
  socket.on('react', async ({ msgId, room, emoji }) => {
    try {
      const msg = await Message.findById(msgId);
      if (!msg) return;
      const list = msg.reactions.get(emoji) ?? [];
      const idx  = list.indexOf(username);
      if (idx === -1) list.push(username); else list.splice(idx, 1);
      if (list.length === 0) msg.reactions.delete(emoji);
      else msg.reactions.set(emoji, list);
      await msg.save();
      io.to(room).emit('reaction_update', {
        msgId, room, reactions: Object.fromEntries(msg.reactions),
      });
    } catch (e) { console.error(e); }
  });

  // ── Disconnect ─────────────────────────────────────────────
  socket.on('disconnect', () => {
    delete onlineUsers[socket.id];
    Object.values(roomTyping).forEach(s => s.delete(socket.id));
    io.emit('users', Object.values(onlineUsers));
    emitSys('general', `${username} chatdan chiqdi`);
  });
});

// ── Yordamchi funksiyalar ──────────────────────────────────────────
const now  = () => new Date().toLocaleTimeString('uz-UZ');
const uid  = () => `sys-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const typers    = (room) =>
  [...(roomTyping[room] ?? [])].map(sid => onlineUsers[sid]?.username).filter(Boolean);

const findSocket = (toUsername, exceptId) =>
  Object.entries(onlineUsers)
    .find(([sid, u]) => u.username === toUsername && sid !== exceptId)?.[0];

const emitSys = (room, text) =>
  io.to(room).emit('message', { id: uid(), type: 'system', room, text, time: now() });

function toClient(msg) {
  const reactions = {};
  if (msg.reactions instanceof Map) {
    for (const [k, v] of msg.reactions) reactions[k] = v;
  } else if (msg.reactions) {
    Object.assign(reactions, msg.reactions);
  }
  return {
    id:       msg._id.toString(),
    type:     msg.type,
    room:     msg.room,
    username: msg.username,
    color:    msg.color,
    text:     msg.text,
    time:     msg.time,
    reactions,
  };
}

const dmToClient = (dm) => ({
  id:        dm._id.toString(),
  type:      'dm',
  from:      dm.from,
  fromColor: dm.fromColor,
  to:        dm.to,
  text:      dm.text,
  time:      dm.time,
});

httpServer.listen(PORT, () => console.log(`🚀 Server: http://localhost:${PORT}`));

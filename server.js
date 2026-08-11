import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import path from 'path';
import { mkdirSync } from 'fs';
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

// ── File upload setup ──────────────────────────────────────────────
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
mkdirSync(UPLOADS_DIR, { recursive: true });
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS_DIR),
  filename:    (_, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname)}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_, file, cb) => {
    const ok = /image|video|gif/.test(file.mimetype);
    cb(null, ok);
  },
});

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

// Serve uploaded files
app.use('/uploads', express.static(UPLOADS_DIR));

// File upload endpoint
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const base = process.env.CLIENT_URL ? process.env.BASE_URL : `http://localhost:${PORT}`;
  const url  = `${process.env.BASE_URL || `http://localhost:${PORT}`}/uploads/${req.file.filename}`;
  const mime = req.file.mimetype;
  const type = mime.startsWith('video') ? 'video' : mime.includes('gif') ? 'gif' : 'image';
  res.json({ url, type, name: req.file.originalname });
});

// ── Search endpoint ────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const { q, room } = req.query;
  if (!q || q.trim().length < 2) return res.json([]);
  try {
    const filter = { type: 'user', deleted: { $ne: true }, text: { $regex: q.trim(), $options: 'i' } };
    if (room) filter.room = room;
    const msgs = await Message.find(filter).sort({ createdAt: -1 }).limit(40).lean();
    res.json(msgs.map(toClient));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'], credentials: true },
});

const onlineUsers = {}; // socketId -> { username, color, status }
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
  onlineUsers[socket.id] = { username, color, status: 'online' };

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
  socket.on('message', async ({ room, text, replyTo, attachment }) => {
    if (!rooms.has(room)) return;
    try {
      const msgData = {
        room, type: 'user', username, color,
        text: (text ?? '').trim(), time: now(),
      };
      if (replyTo?.msgId) msgData.replyTo = replyTo;
      if (attachment?.type) msgData.attachment = attachment;
      const msg = await Message.create(msgData);
      io.to(room).emit('message', toClient(msg));
    } catch (e) { console.error(e); }
  });

  // ── Edit message ───────────────────────────────────────────
  socket.on('edit_message', async ({ msgId, room, text }) => {
    try {
      const msg = await Message.findById(msgId);
      if (!msg || msg.username !== username || msg.deleted) return;
      msg.text   = text.trim();
      msg.edited = true;
      await msg.save();
      io.to(room).emit('message_updated', toClient(msg));
    } catch (e) { console.error(e); }
  });

  // ── Delete message ─────────────────────────────────────────
  socket.on('delete_message', async ({ msgId, room }) => {
    try {
      const msg = await Message.findById(msgId);
      if (!msg || msg.username !== username) return;
      msg.deleted = true;
      await msg.save();
      io.to(room).emit('message_deleted', { msgId, room });
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

  // ── Status ─────────────────────────────────────────────────
  socket.on('set_status', (status) => {
    if (!['online', 'away', 'busy'].includes(status)) return;
    if (onlineUsers[socket.id]) {
      onlineUsers[socket.id].status = status;
      io.emit('users', Object.values(onlineUsers));
    }
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
    id:        msg._id.toString(),
    type:      msg.type,
    room:      msg.room,
    username:  msg.username,
    color:     msg.color,
    text:      msg.text,
    time:      msg.time,
    reactions,
    edited:     msg.edited ?? false,
    deleted:    msg.deleted ?? false,
    replyTo:    msg.replyTo ?? null,
    attachment: msg.attachment ?? null,
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

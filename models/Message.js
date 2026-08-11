import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  room:      { type: String, required: true, index: true },
  type:      { type: String, default: 'user' },
  username:  String,
  color:     String,
  text:      String,
  reactions: { type: Map, of: [String], default: () => new Map() },
  time:      String,
  edited:    { type: Boolean, default: false },
  deleted:   { type: Boolean, default: false },
  replyTo: {
    msgId:    String,
    username: String,
    text:     String,
    color:    String,
  },
  attachment: {
    type: String, // 'image' | 'video' | 'gif' | 'sticker' | 'file'
    url:  String,
    name: String,
  },
}, { timestamps: true });

export default mongoose.model('Message', schema);

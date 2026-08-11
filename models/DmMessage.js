import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  from:      { type: String, required: true, index: true },
  fromColor: String,
  to:        { type: String, required: true, index: true },
  text:      { type: String, required: true },
  time:      String,
}, { timestamps: true });

export default mongoose.model('DmMessage', schema);

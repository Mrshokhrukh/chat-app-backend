import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  username: { type: String, required: true, trim: true },
  phone:    { type: String, required: true, unique: true, trim: true },
  color:    { type: String, required: true },
}, { timestamps: true });

export default mongoose.model('User', schema);

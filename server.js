const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();
const app = express();

// Simple CORS configuration
app.use(cors());
app.use(express.json());

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/saints_welfare';

mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// Member Schema
const memberSchema = new mongoose.Schema({
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  email: String,
  gender: String,
  phoneNumber: String,
  whatsappNumber: String,
  dateOfBirth: Date,
  maritalStatus: String,
  weddingAnniversary: Date,
  residentialAddress: String,
  occupation: String,
  completedFoundationClass: { type: String, default: 'No' },
  churchUnit: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const Member = mongoose.model('Member', memberSchema);

// ========== API ROUTES ==========

// Health check - FIXED (removed members reference)
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Server is running', 
    timestamp: new Date(),
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// GET all members
app.get('/api/members', async (req, res) => {
  try {
    const members = await Member.find().sort({ createdAt: -1 });
    res.json(members);
  } catch (error) {
    console.error('Error fetching members:', error);
    res.status(500).json({ message: error.message });
  }
});

// POST new member
app.post('/api/members', async (req, res) => {
  try {
    const member = new Member(req.body);
    const savedMember = await member.save();
    res.status(201).json(savedMember);
  } catch (error) {
    console.error('Error saving member:', error);
    res.status(400).json({ message: error.message });
  }
});

// GET single member
app.get('/api/members/:id', async (req, res) => {
  try {
    const member = await Member.findById(req.params.id);
    if (!member) return res.status(404).json({ message: 'Member not found' });
    res.json(member);
  } catch (error) {
    console.error('Error fetching member:', error);
    res.status(500).json({ message: error.message });
  }
});

// PUT update member
app.put('/api/members/:id', async (req, res) => {
  try {
    const updatedMember = await Member.findByIdAndUpdate(
      req.params.id,
      { ...req.body, updatedAt: Date.now() },
      { new: true, runValidators: true }
    );
    if (!updatedMember) return res.status(404).json({ message: 'Member not found' });
    res.json(updatedMember);
  } catch (error) {
    console.error('Error updating member:', error);
    res.status(400).json({ message: error.message });
  }
});

// DELETE member
app.delete('/api/members/:id', async (req, res) => {
  try {
    const deletedMember = await Member.findByIdAndDelete(req.params.id);
    if (!deletedMember) return res.status(404).json({ message: 'Member not found' });
    res.json({ message: 'Member deleted successfully' });
  } catch (error) {
    console.error('Error deleting member:', error);
    res.status(500).json({ message: error.message });
  }
});

// Search members
app.get('/api/members/search/:keyword', async (req, res) => {
  try {
    const keyword = req.params.keyword;
    const members = await Member.find({
      $or: [
        { firstName: { $regex: keyword, $options: 'i' } },
        { lastName: { $regex: keyword, $options: 'i' } },
        { phoneNumber: { $regex: keyword, $options: 'i' } },
        { churchUnit: { $regex: keyword, $options: 'i' } }
      ]
    });
    res.json(members);
  } catch (error) {
    console.error('Error searching members:', error);
    res.status(500).json({ message: error.message });
  }
});

// ========== START SERVER ==========
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`\n🚀 Server is running!`);
  console.log(`📡 API URL: http://localhost:${PORT}/api`);
  console.log(`💚 Health check: http://localhost:${PORT}/api/health`);
  console.log(`\n✅ Ready to accept requests\n`);
  console.log('🔗 API_URL:', API_URL);
});
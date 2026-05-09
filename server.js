const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios'); 

dotenv.config();
const app = express();

app.use(cors());
app.use(express.json());

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/saints_welfare';

const MULTITEXTER_API_KEY = process.env.MULTITEXTER_API_KEY;
const MULTITEXTER_SENDER_ID = process.env.MULTITEXTER_SENDER_ID || 'SBC Welfare';

mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// ========== USER SCHEMA ==========
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, default: 'editor' }, // admin, editor, viewer
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// ========== MEMBER SCHEMA ==========
const memberSchema = new mongoose.Schema({
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  email: { type: String, default: '' },
  gender: { type: String, default: '' },
  phoneNumber: { type: String, default: '' },
  whatsappNumber: { type: String, default: '' },
  dateOfBirth: { type: String, default: '' },
  maritalStatus: { type: String, default: '' },
  weddingAnniversary: { type: String, default: '' },
  residentialAddress: { type: String, default: '' },
  occupation: { type: String, default: '' },
  completedFoundationClass: { type: String, default: 'No' },
  churchUnit: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const Member = mongoose.model('Member', memberSchema);

// ========== MIDDLEWARE ==========
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ message: 'Access denied. No token provided.' });
  }
  
  jwt.verify(token, process.env.JWT_SECRET || 'your_secret_key', (err, user) => {
    if (err) {
      return res.status(403).json({ message: 'Invalid or expired token.' });
    }
    req.user = user;
    next();
  });
};

const checkRole = (allowedRoles) => {
  return (req, res, next) => {
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ message: 'You do not have permission to perform this action.' });
    }
    next();
  };
};

function formatNigerianNumber(phoneNumber) {
  if (!phoneNumber) return null;
  
  // Remove any spaces, dashes, or special characters
  let cleaned = phoneNumber.replace(/[^0-9]/g, '');
  
  // Handle different formats
  if (cleaned.startsWith('234')) {
    return '+' + cleaned;
  } else if (cleaned.startsWith('0')) {
    return '+234' + cleaned.slice(1);
  } else if (cleaned.length === 10) {
    return '+234' + cleaned;
  } else {
    return '+' + cleaned;
  }
}

// Send SMS via Multitexter
async function sendSMS(phoneNumber, message) {
  try {
    const formattedNumber = formatNigerianNumber(phoneNumber);
    
    if (!formattedNumber) {
      return { success: false, error: 'Invalid phone number format' };
    }
    
    const response = await axios.post('https://www.multitexter.com/api/v2/sms/send', {
      api_key: MULTITEXTER_API_KEY,
      to: formattedNumber,
      from: MULTITEXTER_SENDER_ID,
      message: message,
      type: 'plain'
    });
    
    // Check response
    if (response.data.status === 'success') {
      return { success: true, data: response.data };
    } else {
      return { success: false, error: response.data.message || 'Failed to send' };
    }
  } catch (error) {
    console.error('Multitexter Error:', error.response?.data || error.message);
    return { success: false, error: error.response?.data?.message || error.message };
  }
}

// ========== AUTH ROUTES ==========

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }
    
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }
    
    const token = jwt.sign(
      { id: user._id, username: user.username, role: user.role },
      process.env.JWT_SECRET || 'your_secret_key',
      { expiresIn: '7d' }
    );
    
    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Verify token
app.get('/api/auth/verify', authenticateToken, (req, res) => {
  res.json({ valid: true, user: req.user });
});

// Create first admin user (run once, then comment out)
app.post('/api/auth/setup', async (req, res) => {
  try {
    const adminExists = await User.findOne({ username: 'admin' });
    if (adminExists) {
      return res.status(400).json({ message: 'Admin already exists' });
    }
    
    const hashedPassword = await bcrypt.hash('admin123', 10);
    const admin = new User({
      username: 'admin',
      password: hashedPassword,
      role: 'admin'
    });
    
    await admin.save();
    res.json({ message: 'Admin user created. Username: admin, Password: admin123' });
  } catch (error) {
    console.error('Setup error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ========== MEMBER ROUTES (Protected) ==========

// Health check (public)
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Server is running', 
    timestamp: new Date(),
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// GET all members (requires authentication)
app.get('/api/members', authenticateToken, async (req, res) => {
  try {
    const members = await Member.find().sort({ createdAt: -1 });
    res.json(members);
  } catch (error) {
    console.error('Error fetching members:', error);
    res.status(500).json({ message: error.message });
  }
});

// POST new member (requires editor or admin)
app.post('/api/members', authenticateToken, checkRole(['admin', 'editor']), async (req, res) => {
  try {
    const member = new Member(req.body);
    const savedMember = await member.save();
    res.status(201).json(savedMember);
  } catch (error) {
    console.error('Error saving member:', error);
    res.status(400).json({ message: error.message });
  }
});

// GET single member (requires authentication)
app.get('/api/members/:id', authenticateToken, async (req, res) => {
  try {
    const member = await Member.findById(req.params.id);
    if (!member) return res.status(404).json({ message: 'Member not found' });
    res.json(member);
  } catch (error) {
    console.error('Error fetching member:', error);
    res.status(500).json({ message: error.message });
  }
});

// PUT update member (requires editor or admin)
app.put('/api/members/:id', authenticateToken, checkRole(['admin', 'editor']), async (req, res) => {
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

// DELETE single member (requires admin only)
app.delete('/api/members/:id', authenticateToken, checkRole(['admin']), async (req, res) => {
  try {
    const deletedMember = await Member.findByIdAndDelete(req.params.id);
    if (!deletedMember) return res.status(404).json({ message: 'Member not found' });
    res.json({ message: 'Member deleted successfully' });
  } catch (error) {
    console.error('Error deleting member:', error);
    res.status(500).json({ message: error.message });
  }
});

// DELETE ALL members (requires admin only)
app.delete('/api/members', authenticateToken, checkRole(['admin']), async (req, res) => {
  try {
    const result = await Member.deleteMany({});
    res.json({ 
      message: 'All members deleted successfully', 
      deletedCount: result.deletedCount 
    });
  } catch (error) {
    console.error('Error deleting all members:', error);
    res.status(500).json({ message: error.message });
  }
});

// Search members (requires authentication)
app.get('/api/members/search/:keyword', authenticateToken, async (req, res) => {
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

// ========== USER MANAGEMENT ROUTES (Super Admin only) ==========

// Get all users (super admin only)
app.get('/api/admin/users', authenticateToken, checkRole(['admin']), async (req, res) => {
  try {
    const users = await User.find({}, '-password'); // Exclude password field
    res.json(users);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ message: error.message });
  }
});

// Create new user (super admin only)
app.post('/api/admin/users', authenticateToken, checkRole(['admin']), async (req, res) => {
  try {
    const { username, password, role } = req.body;
    
    // Check if user exists
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(400).json({ message: 'Username already exists' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({
      username,
      password: hashedPassword,
      role: role || 'viewer'
    });
    
    await newUser.save();
    res.status(201).json({ 
      message: 'User created successfully',
      user: { id: newUser._id, username: newUser.username, role: newUser.role }
    });
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ message: error.message });
  }
});

// Update user role (super admin only)
app.put('/api/admin/users/:id', authenticateToken, checkRole(['admin']), async (req, res) => {
  try {
    const { role } = req.body;
    const userId = req.params.id;
    
    // Prevent changing own role
    if (userId === req.user.id) {
      return res.status(400).json({ message: 'Cannot change your own role' });
    }
    
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { role },
      { new: true, select: '-password' }
    );
    
    if (!updatedUser) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    res.json({ message: 'User role updated successfully', user: updatedUser });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ message: error.message });
  }
});

// Reset user password (super admin only)
app.put('/api/admin/users/:id/reset-password', authenticateToken, checkRole(['admin']), async (req, res) => {
  try {
    const { newPassword } = req.body;
    const userId = req.params.id;
    
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await User.findByIdAndUpdate(userId, { password: hashedPassword });
    
    res.json({ message: 'Password reset successfully' });
  } catch (error) {
    console.error('Error resetting password:', error);
    res.status(500).json({ message: error.message });
  }
});

// Delete user (super admin only)
app.delete('/api/admin/users/:id', authenticateToken, checkRole(['admin']), async (req, res) => {
  try {
    const userId = req.params.id;
    
    // Prevent deleting own account
    if (userId === req.user.id) {
      return res.status(400).json({ message: 'Cannot delete your own account' });
    }
    
    await User.findByIdAndDelete(userId);
    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ message: error.message });
  }
});

// Get account balance
app.get('/api/sms-balance', authenticateToken, checkRole(['admin']), async (req, res) => {
  try {
    const response = await axios.get('https://www.multitexter.com/api/v2/balance', {
      params: { api_key: MULTITEXTER_API_KEY }
    });
    
    res.json(response.data);
  } catch (error) {
    console.error('Balance fetch error:', error);
    res.status(500).json({ message: 'Failed to fetch balance', error: error.message });
  }
});

// Send birthday wish
app.post('/api/send-birthday-wish', authenticateToken, async (req, res) => {
  try {
    const { phoneNumber, name } = req.body;
    
    if (!phoneNumber) {
      return res.status(400).json({ success: false, message: 'Phone number is required' });
    }
    
    const message = `🎂 HAPPY BIRTHDAY! 🎂\n\nDear ${name},\n\nWarmest wishes from the entire family of C&S Saints Builder Church! May your day be filled with God's abundant blessings, joy, and peace.\n\nWe celebrate you today and always! 🙏\n\n- Welfare Team, C&S Saints Builder Church`;
    
    const result = await sendSMS(phoneNumber, message);
    
    if (result.success) {
      res.json({ success: true, message: 'Birthday wish sent successfully!', data: result.data });
    } else {
      res.status(500).json({ success: false, message: result.error });
    }
  } catch (error) {
    console.error('Error sending birthday wish:', error);
    res.status(500).json({ success: false, message: 'Failed to send birthday wish', error: error.message });
  }
});

// Send anniversary wish
app.post('/api/send-anniversary-wish', authenticateToken, async (req, res) => {
  try {
    const { phoneNumber, name, spouseName } = req.body;
    
    if (!phoneNumber) {
      return res.status(400).json({ success: false, message: 'Phone number is required' });
    }
    
    const message = `💍 HAPPY WEDDING ANNIVERSARY! 💍\n\nDear ${name}${spouseName ? ` and ${spouseName}` : ''},\n\nCongratulations on your wedding anniversary! The family of C&S Saints Builder Church celebrates God's faithfulness in your union. May your love continue to grow stronger in Christ Jesus.\n\nWe pray for many more blessed years together! 🙏\n\n- Welfare Team, C&S Saints Builder Church`;
    
    const result = await sendSMS(phoneNumber, message);
    
    if (result.success) {
      res.json({ success: true, message: 'Anniversary wish sent successfully!', data: result.data });
    } else {
      res.status(500).json({ success: false, message: result.error });
    }
  } catch (error) {
    console.error('Error sending anniversary wish:', error);
    res.status(500).json({ success: false, message: 'Failed to send anniversary wish', error: error.message });
  }
});

// Bulk send wishes (today or tomorrow)
app.post('/api/send-bulk-wishes', authenticateToken, checkRole(['admin']), async (req, res) => {
  try {
    const { date } = req.body;
    const targetDate = new Date();
    if (date === 'tomorrow') {
      targetDate.setDate(targetDate.getDate() + 1);
    }
    
    const targetMonth = targetDate.getMonth();
    const targetDay = targetDate.getDate();
    
    const allMembers = await Member.find({});
    const birthdayMembers = [];
    const anniversaryMembers = [];
    
    allMembers.forEach(member => {
      const birthDate = extractMonthDayForMessaging(member.dateOfBirth);
      if (birthDate && birthDate.month === targetMonth && birthDate.day === targetDay) {
        birthdayMembers.push(member);
      }
      
      if (member.maritalStatus === 'Married') {
        const anniversaryDate = extractMonthDayForMessaging(member.weddingAnniversary);
        if (anniversaryDate && anniversaryDate.month === targetMonth && anniversaryDate.day === targetDay) {
          anniversaryMembers.push(member);
        }
      }
    });
    
    const results = {
      birthdays: { sent: [], failed: [] },
      anniversaries: { sent: [], failed: [] }
    };
    
    // Send birthday wishes
    for (const member of birthdayMembers) {
      if (member.phoneNumber) {
        const message = `🎂 HAPPY BIRTHDAY! 🎂\n\nDear ${member.firstName},\n\nWarmest wishes from C&S Saints Builder Church! May God bless you abundantly today and always! 🙏\n\n- Welfare Team`;
        const result = await sendSMS(member.phoneNumber, message);
        
        if (result.success) {
          results.birthdays.sent.push(`${member.firstName} ${member.lastName}`);
        } else {
          results.birthdays.failed.push({ name: `${member.firstName} ${member.lastName}`, error: result.error });
        }
      } else {
        results.birthdays.failed.push({ name: `${member.firstName} ${member.lastName}`, error: 'No phone number' });
      }
    }
    
    // Send anniversary wishes
    for (const member of anniversaryMembers) {
      if (member.phoneNumber) {
        const message = `💍 HAPPY WEDDING ANNIVERSARY! 💍\n\nDear ${member.firstName},\n\nCongratulations! C&S Saints Builder Church celebrates God's faithfulness in your marriage. May God continue to bless your union! 🙏\n\n- Welfare Team`;
        const result = await sendSMS(member.phoneNumber, message);
        
        if (result.success) {
          results.anniversaries.sent.push(`${member.firstName} ${member.lastName}`);
        } else {
          results.anniversaries.failed.push({ name: `${member.firstName} ${member.lastName}`, error: result.error });
        }
      } else {
        results.anniversaries.failed.push({ name: `${member.firstName} ${member.lastName}`, error: 'No phone number' });
      }
    }
    
    res.json({
      success: true,
      message: `Sent ${results.birthdays.sent.length} birthday wishes and ${results.anniversaries.sent.length} anniversary wishes`,
      results
    });
  } catch (error) {
    console.error('Error sending bulk wishes:', error);
    res.status(500).json({ success: false, message: 'Failed to send bulk wishes', error: error.message });
  }
});

// Helper function for date extraction
function extractMonthDayForMessaging(dateString) {
  if (!dateString || dateString === '-') return null;
  
  const monthMap = {
    january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2,
    april: 3, apr: 3, may: 4, june: 5, jun: 5, july: 6, jul: 6,
    august: 7, aug: 7, september: 8, sep: 8, october: 9, oct: 9,
    november: 10, nov: 10, december: 11, dec: 11
  };
  
  // Try to extract month and day
  const patterns = [
    { regex: /(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[\s,]+(\d{1,2})/i },
    { regex: /(\d{1,2})\/(\d{1,2})/ },
    { regex: /(\d{1,2})[\s]+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i }
  ];
  
  for (const pattern of patterns) {
    const match = dateString.match(pattern.regex);
    if (match) {
      if (pattern.regex.toString().includes('january')) {
        const month = monthMap[match[1].toLowerCase()];
        const day = parseInt(match[2]);
        if (month !== undefined && day >= 1 && day <= 31) {
          return { month, day };
        }
      } else if (pattern.regex.toString().includes('/')) {
        const month = parseInt(match[1]) - 1;
        const day = parseInt(match[2]);
        if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
          return { month, day };
        }
      } else if (pattern.regex.toString().includes('\\d{1,2}\\[\\s\\]')) {
        const day = parseInt(match[1]);
        const month = monthMap[match[2].toLowerCase()];
        if (month !== undefined && day >= 1 && day <= 31) {
          return { month, day };
        }
      }
    }
  }
  return null;
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`\n🚀 Server is running!`);
  console.log(`📡 API URL: http://localhost:${PORT}/api`);
  console.log(`💚 Health check: http://localhost:${PORT}/api/health`);
  console.log(`\n✅ Ready to accept requests\n`);
});
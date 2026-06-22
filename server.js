const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios'); 
const cron = require('node-cron');

dotenv.config();
const app = express();

app.use(cors());
app.use(express.json());

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/saints_welfare';

mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// Function to parse date strings into {month, day}
const parseDateString = (dateStr) => {
  if (!dateStr || dateStr === '-') return null;

  // Handle YYYY-MM-DD or MM-DD
  if (dateStr.includes('-')) {
    const parts = dateStr.split('-');
    if (parts.length === 3) {
      return { month: parseInt(parts[1]), day: parseInt(parts[2]) };
    }
    if (parts.length === 2) {
      return { month: parseInt(parts[0]), day: parseInt(parts[1]) };
    }
  }

  const monthMap = {
    january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3,
    april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
    august: 8, aug: 8, september: 9, sep: 9, october: 10, oct: 10,
    november: 11, nov: 11, december: 12, dec: 12
  };

  const patterns = [
    { regex: /(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})/i },
    { regex: /(\d{1,2})\/(\d{1,2})/ },
    { regex: /(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i }
  ];

  for (const pattern of patterns) {
    const match = dateStr.match(pattern.regex);
    if (match) {
      if (pattern.regex.toString().includes('january')) {
        const month = monthMap[match[1].toLowerCase()];
        const day = parseInt(match[2]);
        return { month, day };
      } else if (pattern.regex.toString().includes('/')) {
        const month = parseInt(match[2]);
        const day = parseInt(match[1]);
        if (month > 12) return { month: day, day: month };
        return { month, day };
      } else if (pattern.regex.toString().includes('st|nd|rd|th')) {
        const day = parseInt(match[1]);
        const month = monthMap[match[2].toLowerCase()];
        return { month, day };
      }
    }
  }
  return null;
};

// ========== AUTOMATED TASKS (CRON) ==========

// Schedule celebration SMS to run every day at 8:00 AM
cron.schedule('0 8 * * *', async () => {
  console.log('⏰ Running scheduled celebration SMS task...');
  try {
    const today = new Date();
    const currentMonth = today.getMonth() + 1;
    const currentDay = today.getDate();

    const members = await Member.find({}, 'firstName lastName phoneNumber dateOfBirth weddingAnniversary');

    for (const m of members) {
      if (!m.phoneNumber || m.phoneNumber === '-') continue;

      // Check Birthday
      const dob = parseDateString(m.dateOfBirth);
      if (dob && dob.month === currentMonth && dob.day === currentDay) {
        const message = `Happy Birthday ${m.firstName} ${m.lastName}! We pray that God's grace and blessings be upon you today and always. Have a wonderful celebration! - C&S Saints Builder Church`;
        const result = await sendSMS(m.phoneNumber, message);
        console.log(`🎂 Birthday SMS sent to ${m.firstName} ${m.lastName}`);

        // Log to history
        await new SMSHistory({
          recipients: [m.phoneNumber],
          recipientNames: `${m.firstName} ${m.lastName}`,
          message: message,
          type: 'celebration',
          status: result.success ? 'sent' : 'failed',
          error: result.success ? null : result.error
        }).save();
      }

      // Check Anniversary
      const anniv = parseDateString(m.weddingAnniversary);
      if (anniv && anniv.month === currentMonth && anniv.day === currentDay) {
        const message = `Happy Wedding Anniversary ${m.firstName} ${m.lastName}! May your union continue to be blessed with love, joy, and peace. - C&S Saints Builder Church`;
        const result = await sendSMS(m.phoneNumber, message);

        // Log to history
        await new SMSHistory({
          recipients: [m.phoneNumber],
          recipientNames: `${m.firstName} ${m.lastName}`,
          message: message,
          type: 'celebration',
          status: result.success ? 'sent' : 'failed',
          error: result.success ? null : result.error
        }).save();
        console.log(`💍 Anniversary SMS sent to ${m.firstName} ${m.lastName}`);
      }
    }
  } catch (error) {
    console.error('Error in scheduled celebration SMS:', error);
  }
}, {
  timezone: "Africa/Lagos"
});

// Check for scheduled Bulk SMS every minute
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();
    const pendingSMS = await ScheduledSMS.find({
      status: 'pending',
      scheduledTime: { $lte: now }
    });

    if (pendingSMS.length > 0) {
      console.log(`🕒 Found ${pendingSMS.length} due scheduled SMS...`);
      for (const sms of pendingSMS) {
        try {
          const result = await sendSMS(sms.recipients.join(','), sms.message);
          if (result.success) {
            sms.status = 'sent';
            sms.sentAt = new Date();
          } else {
            sms.status = 'failed';
            sms.error = result.error;
          }

          // Log to history
          await new SMSHistory({
            recipients: sms.recipients,
            recipientNames: sms.recipientNames,
            message: sms.message,
            type: 'scheduled',
            status: sms.status,
            error: sms.error,
            createdBy: sms.createdBy,
            sentAt: new Date()
          }).save();

        } catch (err) {
          sms.status = 'failed';
          sms.error = err.message;
        }
        await sms.save();
      }
    }
  } catch (error) {
    console.error('Error in scheduled SMS runner:', error);
  }
}, {
  timezone: "Africa/Lagos"
});

// ========== USER SCHEMA ==========
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  roles: { type: [String], default: ['editor'] }, // admin, editor, viewer, Executives
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

// Indexes for performance optimization
memberSchema.index({ firstName: 1, lastName: 1 });
memberSchema.index({ gender: 1 });
memberSchema.index({ churchUnit: 1 });
memberSchema.index({ completedFoundationClass: 1 });
memberSchema.index({ phoneNumber: 1 });

const Member = mongoose.model('Member', memberSchema);

// ========== CHILD SCHEMA ==========
const childSchema = new mongoose.Schema({
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  parentsName: { type: String, default: '' },
  parentsPhoneNumber: { type: String, default: '' },
  parentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Member' }],
  dateOfBirth: { type: String, default: '' },
  class: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

childSchema.index({ firstName: 1, lastName: 1 });
childSchema.index({ parentsPhoneNumber: 1 });
childSchema.index({ parentIds: 1 });

const Child = mongoose.model('Child', childSchema);

// ========== CALENDAR SCHEMA ==========
const calendarEventSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String, default: '' },
  eventDate: { type: Date, required: true },
  eventTime: { type: String, default: '' },
  eventType: { 
    type: String, 
    enum: ['service', 'prayer', 'fellowship', 'outreach', 'wedding', 'baptism', 'other'],
    default: 'service'
  },
  location: { type: String, default: '' },
  isRecurring: { type: Boolean, default: false },
  recurrence: {
    pattern: { type: String, enum: ['none', 'daily', 'weekly', 'monthly', 'last_day_of_month', 'nth_day_of_week'] },
    interval: { type: Number, default: 1 }, // every X days/weeks/months
    dayOfWeek: { type: Number }, // 0-6 for weekly or nth_day_of_week
    nth: { type: Number }, // 1 for first, 2 for second, ..., 5 for last
    endDate: { type: Date }
  },
  parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'CalendarEvent' }, // for series management
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

calendarEventSchema.index({ eventDate: 1 });
calendarEventSchema.index({ eventType: 1 });

const CalendarEvent = mongoose.model('CalendarEvent', calendarEventSchema);

// ========== ATTENDANCE SCHEMA ==========
const attendanceSchema = new mongoose.Schema({
  event: { type: mongoose.Schema.Types.ObjectId, ref: 'CalendarEvent', required: true },
  eventDate: { type: Date, required: true }, // For recurring events, this is the instance date
  member: { type: mongoose.Schema.Types.ObjectId, ref: 'Member' },
  child: { type: mongoose.Schema.Types.ObjectId, ref: 'Child' },
  status: { type: String, enum: ['present', 'absent', 'late'], default: 'present' },
  markedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  markedAt: { type: Date, default: Date.now }
});

// Ensure a member or child can only be marked once for a specific event instance
attendanceSchema.index({ event: 1, eventDate: 1, member: 1, child: 1 }, { unique: true });
attendanceSchema.index({ eventDate: -1 });
attendanceSchema.index({ member: 1 });
attendanceSchema.index({ child: 1 });

const Attendance = mongoose.model('Attendance', attendanceSchema);

// ========== GROUP SCHEMA ==========
const groupSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  description: { type: String, default: '' },
  members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Member' }],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const Group = mongoose.model('Group', groupSchema);

// ========== MINUTES OF MEETING SCHEMA ==========
const minutesOfMeetingSchema = new mongoose.Schema({
  title: { type: String, required: true },
  content: { type: String, default: '' },
  meetingDate: { type: Date, default: Date.now },
  attendees: [String],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const MinutesOfMeeting = mongoose.model('MinutesOfMeeting', minutesOfMeetingSchema);

// ========== SCHEDULED SMS SCHEMA ==========
const scheduledSMSSchema = new mongoose.Schema({
  recipients: [String], // Array of phone numbers
  recipientNames: String, // String summary of recipients for UI
  message: { type: String, required: true },
  scheduledTime: { type: Date, required: true },
  status: { type: String, enum: ['pending', 'sent', 'failed', 'cancelled'], default: 'pending' },
  error: String,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now },
  sentAt: Date
});

const ScheduledSMS = mongoose.model('ScheduledSMS', scheduledSMSSchema);

// ========== SMS HISTORY SCHEMA ==========
const smsHistorySchema = new mongoose.Schema({
  recipients: [String],
  recipientNames: String,
  message: { type: String, required: true },
  sentAt: { type: Date, default: Date.now },
  status: { type: String, enum: ['sent', 'failed'], default: 'sent' },
  error: String,
  type: { type: String, enum: ['broadcast', 'group', 'celebration', 'scheduled'], default: 'broadcast' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
});

const SMSHistory = mongoose.model('SMSHistory', smsHistorySchema);

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
    // Support both the new roles array and the legacy role string
    const userRoles = Array.isArray(req.user.roles)
      ? req.user.roles
      : (req.user.role ? [req.user.role] : []);

    const hasPermission = allowedRoles.some(role => userRoles.includes(role));

    if (!hasPermission) {
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

const BULKSMS_TOKEN = process.env.BULKSMS_TOKEN;
const BULKSMS_SENDER_ID = process.env.BULKSMS_SENDER_ID || 'SAINTS';

// Send SMS via BulkSMSNigeria
async function sendSMS(phoneNumber, message) {
  try {
    if (!phoneNumber) return { success: false, error: 'No phone number provided' };

    // Handle multiple numbers (comma-separated string)
    const numbers = phoneNumber.toString().split(',');
    const formattedNumbers = numbers
      .map(num => formatNigerianNumber(num)?.replace('+', ''))
      .filter(Boolean);

    if (formattedNumbers.length === 0) {
      return { success: false, error: 'Invalid phone number format' };
    }

    const recipients = formattedNumbers.join(',');

    if (!BULKSMS_TOKEN) {
      console.warn('SMS simulated (No API Token):', recipients, message);
      return { success: true, simulated: true };
    }
    
    const response = await axios.post('https://www.bulksmsnigeria.com/api/v2/sms', {
      to: recipients,
      from: BULKSMS_SENDER_ID,
      body: message,
      gateway: '0' // Direct delivery gateway
    }, {
      headers: {
        'Authorization': `Bearer ${BULKSMS_TOKEN}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });
    
    // BulkSMSNigeria v2 returns success: true or a data object
    if (response.data && (response.data.data?.status === 'success' || response.data.status === 'success')) {
      return { success: true, data: response.data };
    } else {
      return { success: false, error: response.data.message || 'Failed to send' };
    }
  } catch (error) {
    console.error('BulkSMSNigeria Error:', error.response?.data || error.message);
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

    // Safety check: Ensure 'admin' user always has 'admin' role
    // This fixes cases where the admin user might have been downgraded or lost roles during migration
    if (user.username === 'admin') {
      const currentRoles = Array.isArray(user.roles) ? user.roles : (user.roles ? [user.roles] : []);
      if (!currentRoles.includes('admin')) {
        user.roles = [...currentRoles, 'admin'];
        await user.save();
      }
    }
    
    const token = jwt.sign(
      { id: user._id, username: user.username, roles: user.roles },
      process.env.JWT_SECRET || 'your_secret_key',
      { expiresIn: '7d' }
    );
    
    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        roles: user.roles
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Verify token - Now fetches fresh user data from DB and enforces admin role
app.get('/api/auth/verify', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) {
      return res.status(404).json({ valid: false, message: 'User not found' });
    }

    // Safety check: Ensure 'admin' user always has 'admin' role
    if (user.username === 'admin') {
      const currentRoles = Array.isArray(user.roles) ? user.roles : (user.roles ? [user.roles] : []);
      if (!currentRoles.includes('admin')) {
        console.log('Restoring admin role to admin user during verification');
        user.roles = [...currentRoles, 'admin'];
        await user.save();
      }
    }

    // Generate a fresh token with current roles to prevent staleness
    const freshToken = jwt.sign(
      { id: user._id, username: user.username, roles: user.roles },
      process.env.JWT_SECRET || 'your_secret_key',
      { expiresIn: '7d' }
    );

    res.json({ valid: true, user: user, token: freshToken });
  } catch (error) {
    console.error('Verify error:', error);
    res.status(500).json({ valid: false, message: 'Server error' });
  }
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
      roles: ['admin']
    });
    
    await admin.save();
    res.json({ message: 'Admin user created. Username: admin, Password: admin123' });
  } catch (error) {
    console.error('Setup error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ========== CHILD ROUTES (Protected) ==========

// GET all children
app.get('/api/children', authenticateToken, async (req, res) => {
  try {
    const children = await Child.find().populate('parentIds', 'firstName lastName phoneNumber').sort({ createdAt: -1 });
    res.json(children);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// POST new child
app.post('/api/children', authenticateToken, checkRole(['admin', 'editor']), async (req, res) => {
  try {
    const child = new Child(req.body);
    const savedChild = await child.save();
    res.status(201).json(savedChild);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// GET single child
app.get('/api/children/:id', authenticateToken, async (req, res) => {
  try {
    const child = await Child.findById(req.params.id);
    if (!child) return res.status(404).json({ message: 'Child not found' });
    res.json(child);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// PUT update child
app.put('/api/children/:id', authenticateToken, checkRole(['admin', 'editor']), async (req, res) => {
  try {
    const updatedChild = await Child.findByIdAndUpdate(
      req.params.id,
      { ...req.body, updatedAt: Date.now() },
      { returnDocument: 'after', runValidators: true }
    );
    if (!updatedChild) return res.status(404).json({ message: 'Child not found' });
    res.json(updatedChild);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// DELETE single child
app.delete('/api/children/:id', authenticateToken, checkRole(['admin', 'editor']), async (req, res) => {
  try {
    const deletedChild = await Child.findByIdAndDelete(req.params.id);
    if (!deletedChild) return res.status(404).json({ message: 'Child not found' });
    res.json({ message: 'Child deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ========== MEMBER ROUTES (Protected) ==========

// Health check (public)
app.get('/api/health', (req, res) => {
  console.log(`Ping received at ${new Date().toISOString()}`);
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
      { returnDocument: 'after', runValidators: true }
    );
    if (!updatedMember) return res.status(404).json({ message: 'Member not found' });
    res.json(updatedMember);
  } catch (error) {
    console.error('Error updating member:', error);
    res.status(400).json({ message: error.message });
  }
});

// DELETE single member (requires admin only)
app.delete('/api/members/:id', authenticateToken, checkRole(['admin', 'editor']), async (req, res) => {
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
    const { username, password, roles } = req.body;
    
    // Check if user exists
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(400).json({ message: 'Username already exists' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({
      username,
      password: hashedPassword,
      roles: roles || ['viewer']
    });
    
    await newUser.save();
    res.status(201).json({ 
      message: 'User created successfully',
      user: { id: newUser._id, username: newUser.username, roles: newUser.roles }
    });
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ message: error.message });
  }
});

// Update user roles (super admin only)
app.put('/api/admin/users/:id', authenticateToken, checkRole(['admin']), async (req, res) => {
  try {
    const { roles } = req.body;
    const userId = req.params.id;
    
    // Prevent changing own role
    if (userId === req.user.id) {
      return res.status(400).json({ message: 'Cannot change your own roles' });
    }
    
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { roles },
      { returnDocument: 'after', select: '-password' }
    );
    
    if (!updatedUser) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    res.json({ message: 'User roles updated successfully', user: updatedUser });
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
    await User.findByIdAndUpdate(userId, { password: hashedPassword }, { returnDocument: 'after' });
    
    res.json({ message: 'Password reset successfully' });
  } catch (error) {
    console.error('Error resetting password:', error);
    res.status(500).json({ message: error.message });
  }
});

// Test route to trigger celebration SMS (admin only)
app.post('/api/admin/test-celebrations', authenticateToken, checkRole(['admin']), async (req, res) => {
  console.log('🧪 Manual trigger of celebration SMS task...');
  try {
    const today = new Date();
    const currentMonth = today.getMonth() + 1;
    const currentDay = today.getDate();

    const members = await Member.find({}, 'firstName lastName phoneNumber dateOfBirth weddingAnniversary');
    let birthdayCount = 0;
    let anniversaryCount = 0;
    let errors = [];

    for (const m of members) {
      if (!m.phoneNumber || m.phoneNumber === '-') continue;

      // Check Birthday
      const dob = parseDateString(m.dateOfBirth);
      if (dob && dob.month === currentMonth && dob.day === currentDay) {
        const message = `Happy Birthday ${m.firstName} ${m.lastName}! We pray that God's grace and blessings be upon you today and always. Have a wonderful celebration! - C&S Saints Builder Church`;
        const result = await sendSMS(m.phoneNumber, message);
        if (result.success) birthdayCount++;
        else errors.push(`Birthday SMS failed for ${m.firstName}: ${result.error}`);

        await new SMSHistory({
          recipients: [m.phoneNumber],
          recipientNames: `${m.firstName} ${m.lastName}`,
          message: message,
          type: 'celebration',
          status: result.success ? 'sent' : 'failed',
          error: result.success ? null : result.error,
          createdBy: req.user.id
        }).save();
      }

      // Check Anniversary
      const anniv = parseDateString(m.weddingAnniversary);
      if (anniv && anniv.month === currentMonth && anniv.day === currentDay) {
        const message = `Happy Wedding Anniversary ${m.firstName} ${m.lastName}! May your union continue to be blessed with love, joy, and peace. - C&S Saints Builder Church`;
        const result = await sendSMS(m.phoneNumber, message);
        if (result.success) anniversaryCount++;
        else errors.push(`Anniversary SMS failed for ${m.firstName}: ${result.error}`);

        await new SMSHistory({
          recipients: [m.phoneNumber],
          recipientNames: `${m.firstName} ${m.lastName}`,
          message: message,
          type: 'celebration',
          status: result.success ? 'sent' : 'failed',
          error: result.success ? null : result.error,
          createdBy: req.user.id
        }).save();
      }
    }

    res.json({
      success: true,
      message: `Test completed. Sent ${birthdayCount} birthday and ${anniversaryCount} anniversary SMS.`,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('Error in manual celebration test:', error);
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

// Function to expand recurring events
const expandRecurringEvents = (events, startDate, endDate) => {
  const expandedEvents = [];

  events.forEach(event => {
    if (!event.isRecurring) {
      if (event.eventDate >= startDate && event.eventDate <= endDate) {
        expandedEvents.push(event);
      }
      return;
    }

    // Handle recurring events
    let current = new Date(event.eventDate);
    const recurrenceEnd = event.recurrence.endDate ? new Date(event.recurrence.endDate) : endDate;
    const actualEnd = recurrenceEnd < endDate ? recurrenceEnd : endDate;

    // Safety check: if interval is missing or 0, set to 1
    const interval = event.recurrence.interval || 1;

    while (current <= actualEnd) {
      if (current >= startDate) {
        // Clone event with new date
        const expandedEvent = event.toObject();
        expandedEvent.eventDate = new Date(current);
        expandedEvents.push(expandedEvent);
      }

      // Advance current based on pattern
      if (event.recurrence.pattern === 'daily') {
        current.setDate(current.getDate() + interval);
      } else if (event.recurrence.pattern === 'weekly') {
        current.setDate(current.getDate() + 7 * interval);
      } else if (event.recurrence.pattern === 'monthly') {
        current.setMonth(current.getMonth() + interval);
      } else if (event.recurrence.pattern === 'nth_day_of_week') {
        // Advance to next month
        current.setMonth(current.getMonth() + interval);
        // Find the nth day of week in that month
        const firstDayOfMonth = new Date(current.getFullYear(), current.getMonth(), 1);
        let dayCount = 0;
        let tempDate = new Date(firstDayOfMonth);

        if (event.recurrence.nth === 5) { // "Last"
          const lastDayOfMonth = new Date(current.getFullYear(), current.getMonth() + 1, 0);
          tempDate = new Date(lastDayOfMonth);
          while (tempDate.getDay() !== event.recurrence.dayOfWeek) {
            tempDate.setDate(tempDate.getDate() - 1);
          }
        } else {
          while (dayCount < event.recurrence.nth) {
            if (tempDate.getDay() === event.recurrence.dayOfWeek) {
              dayCount++;
            }
            if (dayCount < event.recurrence.nth) {
              tempDate.setDate(tempDate.getDate() + 1);
            }
          }
        }
        current = tempDate;
      } else {
        break; // Unknown pattern
      }

      // Avoid infinite loops if current doesn't advance
      if (current.getTime() === new Date(event.eventDate).getTime() && interval === 0) break;
    }
  });

  return expandedEvents;
};

// Get all events
app.get('/api/calendar', authenticateToken, async (req, res) => {
  try {
    const { start, end } = req.query;

    // We'll fetch all events that COULD fall into this range
    // For non-recurring: eventDate between start and end
    // For recurring: eventDate <= end AND (recurrence.endDate is null OR recurrence.endDate >= start)
    const events = await CalendarEvent.find({}).sort({ eventDate: 1 });

    if (!start || !end) {
      return res.json(events);
    }

    const startDate = new Date(start);
    const endDate = new Date(end);

    const expandedEvents = expandRecurringEvents(events, startDate, endDate);
    expandedEvents.sort((a, b) => new Date(a.eventDate) - new Date(b.eventDate));
    res.json(expandedEvents);
  } catch (error) {
    console.error('Error fetching events:', error);
    res.status(500).json({ message: error.message });
  }
});

// Get upcoming events (next 30 days)
app.get('/api/calendar/upcoming', authenticateToken, async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Start from beginning of today

    const thirtyDaysLater = new Date(today);
    thirtyDaysLater.setDate(today.getDate() + 30);
    thirtyDaysLater.setHours(23, 59, 59, 999);

    const events = await CalendarEvent.find({}).sort({ eventDate: 1 });
    const expandedEvents = expandRecurringEvents(events, today, thirtyDaysLater);
    expandedEvents.sort((a, b) => new Date(a.eventDate) - new Date(b.eventDate));

    res.json(expandedEvents);
  } catch (error) {
    console.error('Error fetching upcoming events:', error);
    res.status(500).json({ message: error.message });
  }
}); 

// Create event (admin/editor only)
app.post('/api/calendar', authenticateToken, checkRole(['admin', 'editor']), async (req, res) => {
  try {
    const event = new CalendarEvent({
      ...req.body,
      createdBy: req.user.id
    });
    const savedEvent = await event.save();
    res.status(201).json(savedEvent);
  } catch (error) {
    console.error('Error creating event:', error);
    res.status(400).json({ message: error.message });
  }
});

// Update event
app.put('/api/calendar/:id', authenticateToken, checkRole(['admin', 'editor']), async (req, res) => {
  try {
    const updatedEvent = await CalendarEvent.findByIdAndUpdate(
      req.params.id,
      { ...req.body, updatedAt: Date.now() },
      { returnDocument: 'after' }
    );
    if (!updatedEvent) return res.status(404).json({ message: 'Event not found' });
    res.json(updatedEvent);
  } catch (error) {
    console.error('Error updating event:', error);
    res.status(400).json({ message: error.message });
  }
});

// Delete event
app.delete('/api/calendar/:id', authenticateToken, checkRole(['admin']), async (req, res) => {
  try {
    const deletedEvent = await CalendarEvent.findByIdAndDelete(req.params.id);
    if (!deletedEvent) return res.status(404).json({ message: 'Event not found' });
    res.json({ message: 'Event deleted successfully' });
  } catch (error) {
    console.error('Error deleting event:', error);
    res.status(500).json({ message: error.message });
  }
});

// ========== ATTENDANCE ROUTES ==========

// Mark attendance (multiple members/children)
app.post('/api/attendance/bulk', authenticateToken, checkRole(['admin', 'editor']), async (req, res) => {
  try {
    const { eventId, eventDate, records } = req.body;

    if (!eventId || !eventDate) {
      return res.status(400).json({ message: 'eventId and eventDate are required' });
    }

    // Normalize date to ensure matching
    const targetDate = new Date(eventDate);
    const eventObjectId = new mongoose.Types.ObjectId(eventId);

    // First, remove existing records for this instance to handle "deletions"
    const deleteResult = await Attendance.deleteMany({
      event: eventObjectId,
      eventDate: targetDate
    });

    console.log(`Deleted ${deleteResult.deletedCount} old attendance records for ${eventId} on ${targetDate}`);

    if (records && records.length > 0) {
      const attendanceRecords = records.map(record => ({
        event: eventObjectId,
        eventDate: targetDate,
        member: record.memberId ? new mongoose.Types.ObjectId(record.memberId) : undefined,
        child: record.childId ? new mongoose.Types.ObjectId(record.childId) : undefined,
        status: record.status || 'present',
        markedBy: req.user.id,
        markedAt: Date.now()
      }));

      await Attendance.insertMany(attendanceRecords);
      console.log(`Inserted ${records.length} new attendance records`);
    }

    res.json({ message: 'Attendance updated successfully' });
  } catch (error) {
    console.error('Error marking attendance:', error);
    res.status(500).json({ message: 'Failed to update attendance: ' + error.message });
  }
});

// GET all attendance sessions (unique event instances with attendance)
app.get('/api/attendance/sessions', authenticateToken, async (req, res) => {
  try {
    const sessions = await Attendance.aggregate([
      {
        $group: {
          _id: {
            event: "$event",
            eventDate: "$eventDate"
          },
          presentCount: { $sum: 1 },
          memberCount: { $sum: { $cond: [{ $ifNull: ["$member", false] }, 1, 0] } },
          childCount: { $sum: { $cond: [{ $ifNull: ["$child", false] }, 1, 0] } },
          lastMarked: { $max: "$markedAt" }
        }
      },
      {
        $lookup: {
          from: "calendarevents",
          localField: "_id.event",
          foreignField: "_id",
          as: "eventDetails"
        }
      },
      {
        $unwind: {
          path: "$eventDetails",
          preserveNullAndEmptyArrays: false // Only show sessions for events that still exist
        }
      },
      {
        $project: {
          _id: 0,
          eventId: "$_id.event",
          eventDate: "$_id.eventDate",
          title: "$eventDetails.title",
          eventType: "$eventDetails.eventType",
          eventTime: "$eventDetails.eventTime",
          location: "$eventDetails.location",
          presentCount: 1,
          memberCount: 1,
          childCount: 1,
          lastMarked: 1
        }
      },
      { $sort: { eventDate: -1 } }
    ]);

    res.json(sessions);
  } catch (error) {
    console.error('Error fetching attendance sessions:', error);
    res.status(500).json({ message: 'Error loading attendance history: ' + error.message });
  }
});

// Get attendance for an event instance
app.get('/api/attendance', authenticateToken, async (req, res) => {
  try {
    const { eventId, eventDate } = req.query;
    if (!eventId || !eventDate) {
      return res.status(400).json({ message: 'eventId and eventDate are required' });
    }

    const targetDate = new Date(eventDate);
    const eventObjectId = new mongoose.Types.ObjectId(eventId);

    const attendance = await Attendance.find({
      event: eventObjectId,
      eventDate: targetDate
    }).populate('member', 'firstName lastName').populate('child', 'firstName lastName');

    res.json(attendance);
  } catch (error) {
    console.error('Error fetching attendance:', error);
    res.status(500).json({ message: error.message });
  }
});

// Get attendance summary for a member
app.get('/api/attendance/member/:memberId', authenticateToken, async (req, res) => {
  try {
    const attendance = await Attendance.find({ member: req.params.memberId })
      .populate('event', 'title eventType eventTime location')
      .sort({ eventDate: -1 });
    res.json(attendance);
  } catch (error) {
    console.error('Error fetching member attendance:', error);
    res.status(500).json({ message: error.message });
  }
});

// Get attendance summary for a child
app.get('/api/attendance/child/:childId', authenticateToken, async (req, res) => {
  try {
    const attendance = await Attendance.find({ child: req.params.childId })
      .populate('event', 'title eventType eventTime location')
      .sort({ eventDate: -1 });
    res.json(attendance);
  } catch (error) {
    console.error('Error fetching child attendance:', error);
    res.status(500).json({ message: error.message });
  }
});

// ========== REPORTING ROUTES ==========

// Get monthly attendance trends
app.get('/api/reports/attendance-trends', authenticateToken, async (req, res) => {
  try {
    const { months = 6 } = req.query;
    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(endDate.getMonth() - parseInt(months));
    startDate.setDate(1); // Start of month

    const trends = await Attendance.aggregate([
      {
        $match: {
          eventDate: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: "$eventDate" },
            month: { $month: "$eventDate" }
          },
          totalAttendance: { $sum: 1 },
          memberAttendance: { $sum: { $cond: [{ $ifNull: ["$member", false] }, 1, 0] } },
          childAttendance: { $sum: { $cond: [{ $ifNull: ["$child", false] }, 1, 0] } },
          sessionsCount: { $addToSet: { event: "$event", date: "$eventDate" } }
        }
      },
      {
        $project: {
          _id: 0,
          year: "$_id.year",
          month: "$_id.month",
          totalAttendance: 1,
          memberAttendance: 1,
          childAttendance: 1,
          avgAttendance: {
            $cond: [
              { $gt: [{ $size: "$sessionsCount" }, 0] },
              { $divide: ["$totalAttendance", { $size: "$sessionsCount" }] },
              0
            ]
          },
          sessionsCount: { $size: "$sessionsCount" }
        }
      },
      { $sort: { year: 1, month: 1 } }
    ]);

    res.json(trends);
  } catch (error) {
    console.error('Error fetching attendance trends:', error);
    res.status(500).json({ message: error.message });
  }
});

// Get member demographics report
app.get('/api/reports/demographics', authenticateToken, async (req, res) => {
  try {
    const totalMembers = await Member.countDocuments();
    const totalChildren = await Child.countDocuments();

    const genderStats = await Member.aggregate([
      { $group: { _id: "$gender", count: { $sum: 1 } } }
    ]);

    const maritalStats = await Member.aggregate([
      { $group: { _id: "$maritalStatus", count: { $sum: 1 } } }
    ]);

    const foundationClassStats = await Member.aggregate([
      { $group: { _id: "$completedFoundationClass", count: { $sum: 1 } } }
    ]);

    const unitStats = await Member.aggregate([
      { $group: { _id: "$churchUnit", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 15 }
    ]);

    const childClassStats = await Child.aggregate([
      { $group: { _id: "$class", count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    res.json({
      totalMembers,
      totalChildren,
      genderStats,
      maritalStats,
      foundationClassStats,
      unitStats,
      childClassStats
    });
  } catch (error) {
    console.error('Error fetching demographics:', error);
    res.status(500).json({ message: error.message });
  }
});

// ========== SMS & BROADCAST ROUTES ==========

// Get upcoming birthdays and anniversaries (next 14 days)
app.get('/api/sms/upcoming-celebrations', authenticateToken, async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const members = await Member.find({}, 'firstName lastName phoneNumber dateOfBirth weddingAnniversary');
    const celebrations = [];

    const checkCelebration = (m, dateStr, type) => {
      const parsed = parseDateString(dateStr);
      if (!parsed) return;
      for (let i = 0; i <= 14; i++) {
        const futureDate = new Date(today);
        futureDate.setDate(today.getDate() + i);
        if (futureDate.getMonth() + 1 === parsed.month && futureDate.getDate() === parsed.day) {
          celebrations.push({
            memberId: m._id,
            name: `${m.firstName} ${m.lastName}`,
            phoneNumber: m.phoneNumber,
            type: type,
            originalDate: dateStr,
            occurrenceDate: new Date(futureDate),
            daysUntil: i
          });
          break;
        }
      }
    };

    members.forEach(m => {
      checkCelebration(m, m.dateOfBirth, 'Birthday');
      checkCelebration(m, m.weddingAnniversary, 'Anniversary');
    });

    res.json(celebrations.sort((a, b) => a.daysUntil - b.daysUntil));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Broadcast SMS to multiple members
app.post('/api/sms/broadcast', authenticateToken, checkRole(['admin', 'editor']), async (req, res) => {
  try {
    const { memberIds, message } = req.body;
    if (!memberIds || !memberIds.length || !message) {
      return res.status(400).json({ message: 'Member IDs and message are required' });
    }

    const members = await Member.find({ _id: { $in: memberIds } }, 'phoneNumber firstName lastName');
    const validPhoneNumbers = members.map(m => m.phoneNumber).filter(phone => phone && phone !== '-');

    if (validPhoneNumbers.length === 0) {
      return res.status(400).json({ message: 'No valid phone numbers found' });
    }

    const result = await sendSMS(validPhoneNumbers.join(','), message);
    if (result.success) {
      await new SMSHistory({
        recipients: validPhoneNumbers,
        recipientNames: members.map(m => `${m.firstName} ${m.lastName}`).join(', '),
        message: message,
        type: 'broadcast',
        status: 'sent',
        createdBy: req.user.id
      }).save();

      res.json({ message: `Broadcast sent to ${validPhoneNumbers.length} members` });
    } else {
      res.status(500).json({ message: result.error });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ========== GROUP ROUTES ==========

// Get all groups
app.get('/api/groups', authenticateToken, async (req, res) => {
  try {
    const groups = await Group.find().populate('members', 'firstName lastName phoneNumber churchUnit');
    res.json(groups);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create group
app.post('/api/groups', authenticateToken, checkRole(['admin', 'editor']), async (req, res) => {
  try {
    const group = new Group({
      ...req.body,
      createdBy: req.user.id
    });
    await group.save();
    res.status(201).json(group);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update group
app.put('/api/groups/:id', authenticateToken, checkRole(['admin', 'editor']), async (req, res) => {
  try {
    const group = await Group.findByIdAndUpdate(
      req.params.id,
      { ...req.body, updatedAt: Date.now() },
      { returnDocument: 'after' }
    );
    res.json(group);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete group
app.delete('/api/groups/:id', authenticateToken, checkRole(['admin', 'editor']), async (req, res) => {
  try {
    await Group.findByIdAndDelete(req.params.id);
    res.json({ message: 'Group deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Send SMS to group
app.post('/api/groups/:id/send-sms', authenticateToken, checkRole(['admin', 'editor']), async (req, res) => {
  try {
    const { message } = req.body;
    const group = await Group.findById(req.params.id).populate('members', 'phoneNumber');

    if (!group) return res.status(404).json({ message: 'Group not found' });

    const phoneNumbers = group.members
      .map(m => m.phoneNumber)
      .filter(p => p && p !== '-');

    if (phoneNumbers.length === 0) {
      return res.status(400).json({ message: 'No valid phone numbers in this group' });
    }

    const result = await sendSMS(phoneNumbers.join(','), message);

    if (result.success) {
      // Log to history
      await new SMSHistory({
        recipients: phoneNumbers,
        recipientNames: `Group: ${group.name}`,
        message: message,
        type: 'group',
        status: 'sent',
        createdBy: req.user.id
      }).save();

      res.json({ message: `SMS sent to ${phoneNumbers.length} members of ${group.name}` });
    } else {
      // Log failed attempt
      await new SMSHistory({
        recipients: phoneNumbers,
        recipientNames: `Group: ${group.name}`,
        message: message,
        type: 'group',
        status: 'failed',
        error: result.error,
        createdBy: req.user.id
      }).save();

      res.status(500).json({ message: result.error });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ========== SCHEDULED SMS ROUTES ==========

// Get all pending scheduled SMS
app.get('/api/scheduled-sms', authenticateToken, async (req, res) => {
  try {
    const messages = await ScheduledSMS.find({ status: 'pending' }).sort({ scheduledTime: 1 });
    res.json(messages);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Schedule a new SMS
app.post('/api/scheduled-sms', authenticateToken, checkRole(['admin', 'editor']), async (req, res) => {
  try {
    const { memberIds, groupIds, message, scheduledTime } = req.body;

    if (!message || !scheduledTime) {
      return res.status(400).json({ message: 'Message and scheduled time are required' });
    }

    let phoneNumbers = [];
    let recipientNames = [];

    // Collect from individual members
    if (memberIds && memberIds.length > 0) {
      const members = await Member.find({ _id: { $in: memberIds } }, 'phoneNumber firstName lastName');
      members.forEach(m => {
        if (m.phoneNumber && m.phoneNumber !== '-') {
          phoneNumbers.push(m.phoneNumber);
          recipientNames.push(`${m.firstName} ${m.lastName}`);
        }
      });
    }

    // Collect from groups
    if (groupIds && groupIds.length > 0) {
      const groups = await Group.find({ _id: { $in: groupIds } }).populate('members', 'phoneNumber firstName lastName');
      groups.forEach(g => {
        g.members.forEach(m => {
          if (m.phoneNumber && m.phoneNumber !== '-') {
            if (!phoneNumbers.includes(m.phoneNumber)) {
              phoneNumbers.push(m.phoneNumber);
              recipientNames.push(`${m.firstName} ${m.lastName}`);
            }
          }
        });
      });
    }

    if (phoneNumbers.length === 0) {
      return res.status(400).json({ message: 'No valid phone numbers found for recipients' });
    }

    const scheduledSms = new ScheduledSMS({
      recipients: phoneNumbers,
      recipientNames: recipientNames.length > 5 ? `${recipientNames.slice(0, 5).join(', ')} and ${recipientNames.length - 5} others` : recipientNames.join(', '),
      message,
      scheduledTime: new Date(scheduledTime),
      createdBy: req.user.id
    });

    await scheduledSms.save();
    res.status(201).json(scheduledSms);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Cancel a scheduled SMS
app.delete('/api/scheduled-sms/:id', authenticateToken, checkRole(['admin', 'editor']), async (req, res) => {
  try {
    await ScheduledSMS.findByIdAndDelete(req.params.id);
    res.json({ message: 'Scheduled SMS cancelled successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ========== SMS HISTORY ROUTES ==========

// Get SMS history
app.get('/api/sms-history', authenticateToken, async (req, res) => {
  try {
    const history = await SMSHistory.find().sort({ sentAt: -1 }).limit(100);
    res.json(history);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ========== MINUTES OF MEETING ROUTES ==========

// Get all minutes
app.get('/api/minutes', authenticateToken, checkRole(['admin', 'Executives']), async (req, res) => {
  try {
    const minutes = await MinutesOfMeeting.find().sort({ meetingDate: -1 }).populate('createdBy', 'username');
    res.json(minutes);
  } catch (error) {
    console.error('Error fetching minutes:', error);
    res.status(500).json({ message: error.message });
  }
});

// Create new minutes
app.post('/api/minutes', authenticateToken, checkRole(['admin', 'Executives']), async (req, res) => {
  try {
    const { title, content, meetingDate, attendees } = req.body;
    const newMinutes = new MinutesOfMeeting({
      title,
      content,
      meetingDate: meetingDate || Date.now(),
      attendees,
      createdBy: req.user.id
    });
    await newMinutes.save();
    res.status(201).json(newMinutes);
  } catch (error) {
    console.error('Error creating minutes:', error);
    res.status(500).json({ message: error.message });
  }
});

// Update minutes
app.put('/api/minutes/:id', authenticateToken, checkRole(['admin', 'Executives']), async (req, res) => {
  try {
    const { title, content, meetingDate, attendees } = req.body;
    const updatedMinutes = await MinutesOfMeeting.findByIdAndUpdate(
      req.params.id,
      { title, content, meetingDate, attendees, updatedAt: Date.now() },
      { returnDocument: 'after' }
    );
    if (!updatedMinutes) {
      return res.status(404).json({ message: 'Minutes not found' });
    }
    res.json(updatedMinutes);
  } catch (error) {
    console.error('Error updating minutes:', error);
    res.status(500).json({ message: error.message });
  }
});

// Delete minutes
app.delete('/api/minutes/:id', authenticateToken, checkRole(['admin', 'Executives']), async (req, res) => {
  try {
    const deletedMinutes = await MinutesOfMeeting.findByIdAndDelete(req.params.id);
    if (!deletedMinutes) {
      return res.status(404).json({ message: 'Minutes not found' });
    }
    res.json({ message: 'Minutes deleted successfully' });
  } catch (error) {
    console.error('Error deleting minutes:', error);
    res.status(500).json({ message: error.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`\n🚀 Server is running!`);
  console.log(`📡 API URL: http://localhost:${PORT}/api`);
  console.log(`💚 Health check: http://localhost:${PORT}/api/health`);
  console.log(`\n✅ Ready to accept requests\n`);
});
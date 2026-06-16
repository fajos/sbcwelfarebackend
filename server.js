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

const CalendarEvent = mongoose.model('CalendarEvent', calendarEventSchema);

// ========== ATTENDANCE SCHEMA ==========
const attendanceSchema = new mongoose.Schema({
  event: { type: mongoose.Schema.Types.ObjectId, ref: 'CalendarEvent', required: true },
  eventDate: { type: Date, required: true }, // For recurring events, this is the instance date
  member: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true },
  status: { type: String, enum: ['present', 'absent', 'late'], default: 'present' },
  markedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  markedAt: { type: Date, default: Date.now }
});

// Ensure a member can only be marked once for a specific event instance
attendanceSchema.index({ event: 1, eventDate: 1, member: 1 }, { unique: true });

const Attendance = mongoose.model('Attendance', attendanceSchema);

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
    const thirtyDaysLater = new Date();
    thirtyDaysLater.setDate(today.getDate() + 30);
    
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
      { new: true }
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

// Mark attendance (multiple members)
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
        member: new mongoose.Types.ObjectId(record.memberId),
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

// Get all attendance sessions (unique event instances with attendance)
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
    }).populate('member', 'firstName lastName');

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
      .populate('event', 'title')
      .sort({ eventDate: -1 });
    res.json(attendance);
  } catch (error) {
    console.error('Error fetching member attendance:', error);
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
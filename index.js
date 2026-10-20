
const express = require('express');
const mongoose = require('mongoose');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const app = express();
const isProduction = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/appointments', limiter);
app.use('/api/admin/login', limiter);

let cache = global.mongoCache;
if (!cache) cache = global.mongoCache = { promise: null };

const appointmentSchema = new mongoose.Schema({
  bookingReference: { type: String, unique: true, required: true },
  patientName: { type: String, required: true, maxlength: 100 },
  phone: { type: String, required: true, maxlength: 20 },
  email: { type: String, default: '', maxlength: 150 },
  age: { type: Number, required: true, min: 1, max: 120 },
  consultationType: {
    type: String,
    enum: ['general', 'preventive', 'ecg', 'follow-up'],
    required: true
  },
  visitType: { type: String, enum: ['new', 'follow-up'], required: true },
  consultationFee: { type: Number, required: true },
  appointmentStart: { type: Date, required: true },
  appointmentEnd: { type: Date, required: true },
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'completed', 'cancelled'],
    default: 'pending'
  },
  reasonForVisit: { type: String, maxlength: 500, default: '' }
}, { timestamps: true });

appointmentSchema.index({ appointmentStart: 1, status: 1 });

const adminSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  passwordHash: { type: String, required: true },
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

const blockSchema = new mongoose.Schema({
  date: { type: String, unique: true, required: true },
  reason: { type: String, default: '' }
});

const settingsSchema = new mongoose.Schema({
  key: { type: String, unique: true, default: 'clinic' },
  consultationDuration: { type: Number, default: 30 },
  generalFee: { type: Number, default: 800 },
  followUpFee: { type: Number, default: 500 }
});

const Appointment = mongoose.models.Appointment ||
  mongoose.model('Appointment', appointmentSchema);
const Admin = mongoose.models.Admin ||
  mongoose.model('Admin', adminSchema);
const BlockedDate = mongoose.models.BlockedDate ||
  mongoose.model('BlockedDate', blockSchema);
const Settings = mongoose.models.ClinicSettings ||
  mongoose.model('ClinicSettings', settingsSchema);

async function connectDB() {
  if (mongoose.connection.readyState === 1) return mongoose;

  if (!process.env.MONGODB_URI) {
    const e = new Error('MONGODB_URI is missing in Vercel environment variables.');
    e.status = 503;
    throw e;
  }

  if (!cache.promise) {
    cache.promise = mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000
    }).catch(e => {
      cache.promise = null;
      throw e;
    });
  }

  await cache.promise;

  const username = String(process.env.ADMIN_USERNAME || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;

  if (username && password) {
    const existing = await Admin.findOne({ username });
    if (!existing) {
      await Admin.create({
        username,
        passwordHash: await bcrypt.hash(password, 12)
      });
    }
  }

  await Settings.updateOne(
    { key: 'clinic' },
    { $setOnInsert: { key: 'clinic' } },
    { upsert: true }
  );

  return mongoose;
}

const asyncHandler = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const getSecret = () => process.env.SESSION_SECRET;

function auth(req, res, next) {
  if (!getSecret() || getSecret().length < 32) {
    return res.status(503).json({
      error: 'Configure SESSION_SECRET with at least 32 characters.'
    });
  }

  const token = req.cookies.admin_token;
  if (!token) return res.status(401).json({ error: 'Please log in.' });

  try {
    req.admin = jwt.verify(token, getSecret());
    next();
  } catch {
    res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

function istDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function validDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return false;
  }

  const d = new Date(date + 'T00:00:00+05:30');
  return !Number.isNaN(d.getTime()) && istDate(d) === date;
}

function slotsFor(date) {
  if (!validDate(date)) return [];

  const weekday = new Date(date + 'T12:00:00+05:30').getUTCDay();
  if (weekday === 0) return [];

  return [
    '09:00', '09:30', '10:00', '10:30',
    '11:00', '11:30', '12:00', '12:30',
    '16:00', '16:30', '17:00', '17:30',
    '18:00', '18:30'
  ].map(t => new Date(date + 'T' + t + ':00+05:30'));
}

function makeSlot(date, time) {
  if (!validDate(date)) return null;

  if (!slotsFor(date).some(s =>
    s.toLocaleTimeString('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }) === time
  )) return null;

  return new Date(date + 'T' + time + ':00+05:30');
}

async function getSettings() {
  return Settings.findOneAndUpdate(
    { key: 'clinic' },
    { $setOnInsert: { key: 'clinic' } },
    { new: true, upsert: true }
  );
}

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'CardioCare API',
    database: mongoose.connection.readyState === 1 ? 'connected' : 'not-connected'
  });
});

app.get('/api/services', (req, res) => {
  res.json({
    services: [
      { id: 'general', name: 'General Cardiology', fee: 800 },
      { id: 'preventive', name: 'Preventive Heart Check', fee: 800 },
      { id: 'ecg', name: 'ECG Consultation', fee: 800 },
      { id: 'follow-up', name: 'Follow-up Consultation', fee: 500 }
    ]
  });
});

app.get('/api/availability', asyncHandler(async (req, res) => {
  await connectDB();

  const date = String(req.query.date || '');
  if (!validDate(date)) {
    return res.status(400).json({ error: 'Use a valid YYYY-MM-DD date.' });
  }

  if (date < istDate() || await BlockedDate.exists({ date })) {
    return res.json({ available: [] });
  }

  const start = new Date(date + 'T00:00:00+05:30');
  const end = new Date(date + 'T23:59:59.999+05:30');

  const booked = await Appointment.find({
    appointmentStart: { $gte: start, $lte: end },
    status: { $in: ['pending', 'confirmed', 'completed'] }
  }).select('appointmentStart').lean();

  const occupied = new Set(booked.map(a =>
    new Date(a.appointmentStart).getTime()
  ));

  const available = slotsFor(date)
    .filter(s => s.getTime() > Date.now() && !occupied.has(s.getTime()))
    .map(s => s.toLocaleTimeString('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }));

  res.json({ available });
}));

app.post('/api/appointments', asyncHandler(async (req, res) => {
  await connectDB();

  const b = req.body || {};
  const patientName = String(b.patientName || '').trim();
  const phone = String(b.phone || '').trim();
  const email = String(b.email || '').trim().toLowerCase();
  const age = Number(b.age);
  const date = String(b.date || '');
  const time = String(b.time || '');
  const visitType = String(b.visitType || 'new');
  const consultationType = String(b.consultationType || 'general');
  const reasonForVisit = String(b.reasonForVisit || '').trim();

  if (!patientName || patientName.length > 100 ||
      !/^[+()\-\s\d]{7,20}$/.test(phone) ||
      !Number.isInteger(age) || age < 1 || age > 120 ||
      (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) ||
      !['new', 'follow-up'].includes(visitType) ||
      !['general', 'preventive', 'ecg', 'follow-up'].includes(consultationType) ||
      reasonForVisit.length > 500) {
    return res.status(400).json({ error: 'Please check the form details.' });
  }

  const start = makeSlot(date, time);
  if (!start || start.getTime() <= Date.now()) {
    return res.status(400).json({ error: 'Choose a valid future appointment slot.' });
  }

  if (await BlockedDate.exists({ date })) {
    return res.status(409).json({ error: 'The clinic is closed on this date.' });
  }

  const conflict = await Appointment.exists({
    appointmentStart: start,
    status: { $in: ['pending', 'confirmed', 'completed'] }
  });

  if (conflict) {
    return res.status(409).json({ error: 'This slot has already been booked.' });
  }

  const settings = await getSettings();
  const fee = visitType === 'follow-up'
    ? settings.followUpFee
    : settings.generalFee;

  const bookingReference =
    'CC-' + crypto.randomBytes(5).toString('hex').toUpperCase();

  const appointment = await Appointment.create({
    bookingReference,
    patientName,
    phone,
    email,
    age,
    consultationType,
    visitType,
    consultationFee: fee,
    appointmentStart: start,
    appointmentEnd: new Date(start.getTime() + settings.consultationDuration * 60000),
    reasonForVisit,
    status: 'pending'
  });

  res.status(201).json({
    success: true,
    bookingReference: appointment.bookingReference,
    appointmentStart: appointment.appointmentStart,
    status: appointment.status
  });
}));

app.get('/api/appointments/:reference', asyncHandler(async (req, res) => {
  await connectDB();

  const reference = String(req.params.reference || '').toUpperCase();
  const appointment = await Appointment.findOne({
    bookingReference: reference
  }).select(
    'bookingReference appointmentStart appointmentEnd status consultationType visitType consultationFee'
  ).lean();

  if (!appointment) {
    return res.status(404).json({ error: 'Appointment not found.' });
  }

  res.json({ appointment });
}));

app.post('/api/admin/login', asyncHandler(async (req, res) => {
  await connectDB();

  if (!getSecret() || getSecret().length < 32) {
    return res.status(503).json({ error: 'Admin authentication is not configured.' });
  }

  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const admin = await Admin.findOne({ username, isActive: true });

  if (!admin || !(await bcrypt.compare(password, admin.passwordHash))) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  const token = jwt.sign(
    { id: String(admin._id) },
    getSecret(),
    { expiresIn: '8h' }
  );

  res.cookie('admin_token', token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/',
    maxAge: 8 * 60 * 60 * 1000
  });

  res.json({ success: true });
}));

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('admin_token', {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/'
  });
  res.json({ success: true });
});

app.get('/api/admin/me', auth, asyncHandler(async (req, res) => {
  await connectDB();
  const admin = await Admin.findById(req.admin.id)
    .select('username isActive').lean();

  if (!admin || !admin.isActive) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  res.json({ authenticated: true, username: admin.username });
}));

app.get('/api/admin/stats', auth, asyncHandler(async (req, res) => {
  await connectDB();

  const today = istDate();
  const start = new Date(today + 'T00:00:00+05:30');
  const end = new Date(today + 'T23:59:59.999+05:30');

  const [total, pending, confirmed, cancelled, todayCount] = await Promise.all([
    Appointment.countDocuments(),
    Appointment.countDocuments({ status: 'pending' }),
    Appointment.countDocuments({ status: 'confirmed' }),
    Appointment.countDocuments({ status: 'cancelled' }),
    Appointment.countDocuments({
      appointmentStart: { $gte: start, $lte: end }
    })
  ]);

  res.json({ total, pending, confirmed, cancelled, today: todayCount });
}));

app.get('/api/admin/appointments', auth, asyncHandler(async (req, res) => {
  await connectDB();

  const filter = {};
  const status = String(req.query.status || '');
  const date = String(req.query.date || '');

  if (['pending', 'confirmed', 'completed', 'cancelled'].includes(status)) {
    filter.status = status;
  }

  if (date) {
    if (!validDate(date)) {
      return res.status(400).json({ error: 'Invalid date.' });
    }

    filter.appointmentStart = {
      $gte: new Date(date + 'T00:00:00+05:30'),
      $lte: new Date(date + 'T23:59:59.999+05:30')
    };
  }

  const appointments = await Appointment.find(filter)
    .sort({ appointmentStart: -1 }).limit(100).lean();

  res.json({ appointments });
}));

app.patch('/api/admin/appointments/:id/status', auth, asyncHandler(async (req, res) => {
  await connectDB();

  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ error: 'Invalid appointment ID.' });
  }

  const status = String(req.body?.status || '');
  if (!['pending', 'confirmed', 'completed', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'Invalid appointment status.' });
  }

  const appointment = await Appointment.findByIdAndUpdate(
    req.params.id,
    { $set: { status } },
    { new: true, runValidators: true }
  );

  if (!appointment) {
    return res.status(404).json({ error: 'Appointment not found.' });
  }

  res.json({ success: true, appointment });
}));

app.get('/api/admin/settings', auth, asyncHandler(async (req, res) => {
  await connectDB();
  const settings = await getSettings();
  const blockedDates = await BlockedDate.find().sort({ date: 1 }).lean();
  res.json({ settings, blockedDates });
}));

app.patch('/api/admin/settings', auth, asyncHandler(async (req, res) => {
  await connectDB();

  const update = {};
  for (const key of ['generalFee', 'followUpFee']) {
    if (req.body?.[key] !== undefined) {
      const value = Number(req.body[key]);
      if (!Number.isFinite(value) || value < 0 || value > 100000) {
        return res.status(400).json({ error: 'Invalid consultation fee.' });
      }
      update[key] = value;
    }
  }

  if (req.body?.consultationDuration !== undefined) {
    const duration = Number(req.body.consultationDuration);
    if (![15, 30, 45, 60, 90, 120].includes(duration)) {
      return res.status(400).json({ error: 'Invalid consultation duration.' });
    }
    update.consultationDuration = duration;
  }

  const settings = await Settings.findOneAndUpdate(
    { key: 'clinic' },
    { $set: update, $setOnInsert: { key: 'clinic' } },
    { new: true, upsert: true }
  );

  res.json({ settings });
}));

app.post('/api/admin/blocked-dates', auth, asyncHandler(async (req, res) => {
  await connectDB();

  const date = String(req.body?.date || '');
  if (!validDate(date)) {
    return res.status(400).json({ error: 'Invalid date.' });
  }

  await BlockedDate.updateOne(
    { date },
    { $set: { reason: String(req.body?.reason || '').slice(0, 200) } },
    { upsert: true }
  );

  res.status(201).json({ success: true, date });
}));

app.delete('/api/admin/blocked-dates/:id', auth, asyncHandler(async (req, res) => {
  await connectDB();

  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ error: 'Invalid blocked-date ID.' });
  }

  const result = await BlockedDate.findByIdAndDelete(req.params.id);
  if (!result) return res.status(404).json({ error: 'Blocked date not found.' });

  res.json({ success: true });
}));

const publicHTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CardioCare | Heart & Wellness Clinic</title>
<meta name="description" content="Book a cardiology consultation at CardioCare.">
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--coral:#ff6b6b;--navy:#24324a;--mint:#bdf3de;--sky:#bde5ff;--lav:#dccbff;--cream:#fff8f0;--peach:#ffd6c9;--text:#344054;--shadow:8px 8px 18px #e5dcd2,-7px -7px 18px #fff}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--cream);color:var(--text);font-family:"Plus Jakarta Sans",sans-serif;line-height:1.65}h1,h2,h3{font-family:Manrope,sans-serif;color:var(--navy)}.wrap{width:min(1120px,92%);margin:auto}.nav{position:sticky;top:8px;z-index:5;margin:10px auto;width:94%}.navin{display:flex;justify-content:space-between;align-items:center;gap:15px;padding:14px 22px;border-radius:50px;background:#fff8f0ed;box-shadow:var(--shadow)}.logo{font-size:1.4rem;font-weight:800;color:var(--coral);text-decoration:none}.links{display:flex;gap:18px}.links a{text-decoration:none;font-weight:700;color:var(--navy)}.btn{display:inline-block;border:0;border-radius:30px;background:var(--coral);color:white;padding:13px 22px;text-decoration:none;font-weight:800;cursor:pointer;box-shadow:4px 5px 12px #ff6b6b44}.btn.alt{background:var(--sky);color:var(--navy)}.hero{display:grid;grid-template-columns:1fr 1fr;gap:45px;align-items:center;padding:70px 0}.hero h1{font-size:clamp(2.5rem,5vw,4rem);line-height:1.13;letter-spacing:-.04em}.hero p{color:#667085;font-size:1.1rem}.eyebrow{display:inline-block;padding:7px 14px;border-radius:30px;background:var(--peach);color:#b74343;font-weight:800}.portrait{min-height:400px;position:relative;border-radius:35px;background:linear-gradient(135deg,var(--sky),var(--lav));box-shadow:var(--shadow);display:grid;place-items:center;font-size:7rem}.bubble{position:absolute;background:white;padding:14px 18px;border-radius:18px;box-shadow:var(--shadow);font-size:1rem;font-weight:800}.bubble.one{bottom:25px;left:15px}.bubble.two{top:25px;right:15px}section{padding:65px 0}.head{text-align:center;max-width:700px;margin:0 auto 35px}.head h2{font-size:clamp(2rem,4vw,3rem)}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:22px}.card{border:2px solid #fff9;border-radius:26px;padding:26px;background:var(--cream);box-shadow:var(--shadow);transition:.25s}.card:hover{transform:translateY(-5px)}.icon{font-size:2rem;width:55px;height:55px;display:grid;place-items:center;border-radius:18px;background:var(--lav)}.mint{background:var(--mint)}.sky{background:var(--sky)}.peach{background:var(--peach)}.booking{padding:clamp(22px,5vw,48px);border-radius:32px;background:linear-gradient(135deg,#bdf3de77,#dccbff77)}.formgrid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.field label{display:block;font-weight:800;margin-bottom:6px}.field input,.field select,.field textarea{width:100%;padding:13px;border:2px solid white;border-radius:14px;background:#ffffffc9;font:inherit}.full{grid-column:1/-1}.slots{display:flex;gap:9px;flex-wrap:wrap;margin:10px 0}.slot{border:0;border-radius:12px;background:white;padding:10px 14px;box-shadow:var(--shadow);cursor:pointer}.slot.selected{background:var(--coral);color:white}.notice{display:none;padding:12px;border-radius:12px;margin-bottom:15px}.notice.show{display:block}.error{background:#ffe0e0;color:#8b2525}.ok{background:#d8f8e8;color:#155b3d}.faq details{padding:17px;background:#fff9;border-radius:15px;margin:10px 0;box-shadow:var(--shadow)}summary{font-weight:800;cursor:pointer}footer{background:var(--navy);color:white;padding:40px 0;border-radius:30px 30px 0 0}footer h2,footer h3{color:white}footer a{color:var(--sky)}@media(max-width:760px){.hero{grid-template-columns:1fr;padding:40px 0}.portrait{min-height:300px}.links{display:none}.grid{grid-template-columns:1fr}.formgrid{grid-template-columns:1fr}.full{grid-column:auto}}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
</style>
</head>
<body>
<nav class="nav"><div class="navin"><a class="logo" href="/">♥ CardioCare</a><div class="links"><a href="#doctor">Doctor</a><a href="#services">Services</a><a href="#health">Heart Health</a><a href="#contact">Contact</a></div><a class="btn" href="#booking">Book Now</a></div></nav>
<main class="wrap">
<header class="hero"><div><span class="eyebrow">YOUR HEART, OUR PRIORITY</span><h1>A healthier heart starts with the right care.</h1><p>Personalized cardiac consultations, preventive screening and thoughtful follow-up care.</p><a class="btn" href="#booking">Book an Appointment →</a> <a class="btn alt" href="#doctor">Meet the Doctor</a><p><small>Fictional demo clinic. Verify all details before public launch.</small></p></div><div class="portrait">♥<div class="bubble one">Patient-first care</div><div class="bubble two">Cardiology clinic</div></div></header>
<section id="doctor"><div class="head"><span class="eyebrow">MEET YOUR DOCTOR</span><h2>Dr. Aarav Mehta</h2><p>Fictional profile placeholder. Verify qualifications before publishing.</p></div><div class="grid"><article class="card"><div class="icon mint">♡</div><h3>Personalized Care</h3><p>Consultations tailored to individual concerns and clinical assessment.</p></article><article class="card"><div class="icon sky">✚</div><h3>Preventive Health</h3><p>Discuss heart-health risks and prevention with a qualified clinician.</p></article><article class="card"><div class="icon peach">⌁</div><h3>Follow-up Support</h3><p>Appointment requests and follow-up coordination.</p></article></div></section>
<section id="services"><div class="head"><h2>Our Services</h2><p>Choose your consultation type below.</p></div><div class="grid"><article class="card"><div class="icon">♡</div><h3>General Cardiology</h3><p>General consultation and discussion of heart-health concerns.</p><button class="btn choose" data-type="general">Book · ₹800</button></article><article class="card"><div class="icon mint">✚</div><h3>Preventive Check-up</h3><p>Preventive screening discussion and risk assessment.</p><button class="btn choose" data-type="preventive">Book · ₹800</button></article><article class="card"><div class="icon sky">⌁</div><h3>ECG Consultation</h3><p>Consultation about ECG testing where clinically appropriate.</p><button class="btn choose" data-type="ecg">Book · ₹800</button></article></div></section>
<section id="booking"><div class="head"><span class="eyebrow">ONLINE BOOKING</span><h2>Request an Appointment</h2><p>Your appointment remains pending until confirmed by the clinic.</p></div><div class="booking"><div id="notice" class="notice"></div><form id="form"><div class="formgrid">
<div class="field"><label for="type">Consultation</label><select id="type"><option value="general">General Cardiology</option><option value="preventive">Preventive Check-up</option><option value="ecg">ECG Consultation</option><option value="follow-up">Follow-up</option></select></div>
<div class="field"><label for="visit">Visit Type</label><select id="visit"><option value="new">New · ₹800</option><option value="follow-up">Follow-up · ₹500</option></select></div>
<div class="field"><label for="date">Date</label><input id="date" type="date" required></div>
<div class="field"><label>Available Time</label><div id="slots" class="slots">Choose a date first.</div></div>
<div class="field"><label for="name">Patient Name</label><input id="name" maxlength="100" required></div>
<div class="field"><label for="phone">Phone Number</label><input id="phone" maxlength="20" required></div>
<div class="field"><label for="email">Email (optional)</label><input id="email" type="email"></div>
<div class="field"><label for="age">Age</label><input id="age" type="number" min="1" max="120" required></div>
<div class="field full"><label for="reason">Reason for Visit (optional)</label><textarea id="reason" maxlength="500" rows="3"></textarea></div>
<div class="field full"><label><input id="consent" type="checkbox" required style="width:auto"> I agree to share these details for appointment scheduling.</label></div>
<div class="field full"><button class="btn" id="submit" type="submit">Request Appointment →</button></div>
</div></form></div></section>
<section id="health"><div class="head"><h2>Heart Health Matters</h2></div><div class="grid"><article class="card"><h3>Know Your Numbers</h3><p>Discuss blood pressure and heart-health risk factors with your clinician.</p></article><article class="card"><h3>Healthy Habits</h3><p>Ask a professional about activity, nutrition, sleep and preventive care.</p></article><article class="card"><h3>Medical Emergency?</h3><p>For severe chest pain or breathing difficulty, contact local emergency services immediately. Do not wait for an online appointment.</p></article></div></section>
<section class="faq"><div class="head"><h2>Frequently Asked Questions</h2></div><details><summary>Is the appointment immediately confirmed?</summary><p>No. The booking is pending until the clinic confirms it.</p></details><details><summary>Can I change my booking?</summary><p>Contact the clinic using its verified contact details.</p></details><details><summary>Is this a real clinic?</summary><p>No. All clinic and doctor information here is fictional demo content.</p></details></section>
<section id="contact"><div class="head"><h2>Contact CardioCare</h2></div><div class="grid"><article class="card"><h3>Address</h3><p>204, Serenity Medical Plaza, Baner Road, Pune 411045</p><small>Fictional demo address.</small></article><article class="card"><h3>Contact</h3><p>+91 90000 12345</p><p>appointments@example.com</p><small>Demo contact details.</small></article><article class="card"><h3>Opening Hours</h3><p>Monday–Saturday</p><p>9 AM–1 PM, 4 PM–7 PM</p><p>Sunday closed</p></article></div></section>
</main>
<footer><div class="wrap"><h2>♥ CardioCare</h2><p>Fictional demo website. Not a substitute for medical advice or emergency care.</p><a href="/admin">Admin Dashboard</a> · © <span id="year"></span></div></footer>
<script>
const $=id=>document.getElementById(id);
let selected='';
$('year').textContent=new Date().getFullYear();
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
$('date').min=today();
function notice(msg,type){const n=$('notice');n.textContent=msg;n.className='notice show '+type;}
function labelTime(t){const [h,m]=t.split(':').map(Number);const d=new Date();d.setHours(h,m);return d.toLocaleTimeString('en-IN',{hour:'numeric',minute:'2-digit'});}
async function loadSlots(){
 selected='';const date=$('date').value;const box=$('slots');box.textContent='Loading…';if(!date){box.textContent='Choose a date first.';return;}
 try{const r=await fetch('/api/availability?date='+encodeURIComponent(date));const data=await r.json();box.innerHTML='';
 if(!r.ok)throw Error(data.error||'Unable to load slots');
 if(!data.available.length){box.textContent='No available slots on this date.';return;}
 data.available.forEach(t=>{const b=document.createElement('button');b.type='button';b.className='slot';b.textContent=labelTime(t);b.onclick=()=>{selected=t;box.querySelectorAll('button').forEach(x=>x.classList.remove('selected'));b.classList.add('selected');};box.appendChild(b);});
 }catch(e){box.textContent='Could not load slots. Check database connection.';}
}
$('date').addEventListener('change',loadSlots);
document.querySelectorAll('.choose').forEach(b=>b.addEventListener('click',()=>{$('type').value=b.dataset.type;$('booking').scrollIntoView({behavior:'smooth'});}));
$('form').addEventListener('submit',async e=>{
 e.preventDefault();if(!selected)return notice('Please choose a time slot.','error');
 if(!$('consent').checked)return notice('Please accept the consent.','error');
 const btn=$('submit');btn.disabled=true;btn.textContent='Submitting…';
 try{
 const payload={date:$('date').value,time:selected,patientName:$('name').value.trim(),phone:$('phone').value.trim(),email:$('email').value.trim(),age:Number($('age').value),consultationType:$('type').value,visitType:$('visit').value,reasonForVisit:$('reason').value.trim()};
 const r=await fetch('/api/appointments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
 const data=await r.json();if(!r.ok)throw Error(data.error||'Booking failed');
 notice('Request received! Booking reference: '+data.bookingReference+'. Await clinic confirmation.','ok');
 $('form').reset();$('date').min=today();selected='';$('slots').textContent='Choose a date first.';
 }catch(err){notice(err.message,'error');await loadSlots();}
 finally{btn.disabled=false;btn.textContent='Request Appointment →';}
});
</script>
</body>
</html>`;

app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(publicHTML);
});

app.get('/admin', (req, res) => {
  try {
    const dashboard = require('./admin.js');

    if (typeof dashboard === 'string') {
      return res.type('html').send(dashboard);
    }

    if (typeof dashboard === 'function') {
      if (dashboard.length >= 2) return dashboard(req, res);

      const html = dashboard();
      if (typeof html === 'string') return res.type('html').send(html);
    }

    res.status(500).send(
      'admin.js must export HTML or a compatible dashboard handler.'
    );
  } catch (err) {
    console.error('Admin dashboard error:', err.message);
    res.status(500).send('Could not load admin.js. Check its export format.');
  }
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API endpoint not found.' });
  }
  res.status(404).send('Page not found. <a href="/">Return home</a>');
});

app.use((err, req, res, next) => {
  console.error('Request error:', err.message || err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({
    error: err.status === 503 ? err.message : 'Internal server error.'
  });
});

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log('CardioCare running on port ' + port));
}

module.exports = app;

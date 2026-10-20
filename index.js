
'use strict';

const express = require('express');
const mongoose = require('mongoose');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '20kb' }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(cookieParser());

app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 150,
  standardHeaders: 'draft-7',
  legacyHeaders: false
}));

let dbPromise;

async function connectDB() {
  if (!MONGODB_URI) throw new Error('MONGODB_URI is not configured');
  if (mongoose.connection.readyState === 1) return;
  if (!dbPromise || mongoose.connection.readyState === 0) {
    dbPromise = mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 10000
    }).catch(error => {
      dbPromise = null;
      throw error;
    });
  }
  await dbPromise;
}

const appointmentSchema = new mongoose.Schema({
  reference: { type: String, unique: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  phone: { type: String, required: true, trim: true, maxlength: 20 },
  email: { type: String, trim: true, lowercase: true, maxlength: 150, default: '' },
  service: { type: String, required: true, maxlength: 100 },
  date: { type: String, required: true },
  time: { type: String, required: true },
  message: { type: String, trim: true, maxlength: 500, default: '' },
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'completed', 'cancelled'],
    default: 'pending'
  }
}, { timestamps: true });

appointmentSchema.index({ date: 1, time: 1, status: 1 });

const blockedDateSchema = new mongoose.Schema({
  date: { type: String, unique: true, required: true },
  reason: { type: String, maxlength: 200, default: '' }
});

const settingsSchema = new mongoose.Schema({
  key: { type: String, unique: true, default: 'clinic' },
  clinicName: { type: String, default: 'CardioCare' },
  phone: { type: String, default: '' },
  address: { type: String, default: '' },
  openingTime: { type: String, default: '09:00' },
  closingTime: { type: String, default: '17:00' }
});

const Appointment = mongoose.model('Appointment', appointmentSchema);
const BlockedDate = mongoose.model('BlockedDate', blockedDateSchema);
const Settings = mongoose.model('Settings', settingsSchema);

function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return false;
  const d = new Date(date + 'T12:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

function isPastDate(date) {
  const today = new Date().toLocaleDateString('en-CA', {
    timeZone: 'Asia/Kolkata'
  });
  return date < today;
}

function slotsFor(date) {
  if (!validDate(date)) return [];
  const day = new Date(date + 'T12:00:00Z').getUTCDay();
  if (day === 0) return [];

  const slots = [];
  for (let mins = 9 * 60; mins < 17 * 60; mins += 30) {
    const hour = Math.floor(mins / 60);
    const minute = mins % 60;
    slots.push(
      String(hour).padStart(2, '0') + ':' +
      String(minute).padStart(2, '0')
    );
  }
  return slots;
}

function validPhone(phone) {
  return /^[+0-9 ()-]{7,20}$/.test(phone || '');
}

function validTime(time) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(time || '');
}

function safeText(value, max = 100) {
  return String(value || '').trim().slice(0, max);
}

function signToken() {
  if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 characters');
  }
  return jwt.sign(
    { username: ADMIN_USERNAME },
    SESSION_SECRET,
    { expiresIn: '8h' }
  );
}

function requireAdmin(req, res, next) {
  try {
    if (!SESSION_SECRET) {
      return res.status(503).json({ error: 'Admin authentication is not configured' });
    }
    const token = req.cookies.admin_session;
    if (!token) return res.status(401).json({ error: 'Please log in again' });

    const payload = jwt.verify(token, SESSION_SECRET);
    if (payload.username !== ADMIN_USERNAME) {
      return res.status(401).json({ error: 'Invalid session' });
    }
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' }
});

app.get('/api/health', async (req, res) => {
  try {
    await connectDB();
    res.json({ ok: true, database: 'connected' });
  } catch (error) {
    console.error('Health check:', error.message);
    res.status(503).json({ ok: false, database: 'unavailable' });
  }
});

app.get('/api/services', (req, res) => {
  res.json({
    services: [
      'Cardiac Consultation',
      'Heart-Health Screening',
      'Follow-up Care'
    ]
  });
});

app.get('/api/availability', async (req, res) => {
  try {
    await connectDB();

    const date = safeText(req.query.date, 10);
    if (!validDate(date)) {
      return res.status(400).json({ error: 'Choose a valid date' });
    }
    if (isPastDate(date)) {
      return res.status(400).json({ error: 'Please choose a future date' });
    }

    const blocked = await BlockedDate.findOne({ date }).lean();
    if (blocked) return res.json({ date, slots: [] });

    const allSlots = slotsFor(date);
    const booked = await Appointment.find({
      date,
      status: { $ne: 'cancelled' }
    }).select('time').lean();

    const taken = new Set(booked.map(item => item.time));
    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: 'Asia/Kolkata'
    });
    const currentTime = new Date().toLocaleTimeString('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });

    const slots = allSlots.filter(time =>
      !taken.has(time) && (date !== today || time > currentTime)
    );

    res.json({ date, slots });
  } catch (error) {
    console.error('Availability error:', error.message);
    res.status(500).json({ error: 'Unable to check availability' });
  }
});

app.post('/api/appointments', async (req, res) => {
  try {
    await connectDB();

    const name = safeText(req.body.name, 100);
    const phone = safeText(req.body.phone, 20);
    const email = safeText(req.body.email, 150).toLowerCase();
    const service = safeText(req.body.service, 100);
    const date = safeText(req.body.date, 10);
    const time = safeText(req.body.time, 5);
    const message = safeText(req.body.message, 500);

    if (name.length < 2) {
      return res.status(400).json({ error: 'Enter your full name' });
    }
    if (!validPhone(phone)) {
      return res.status(400).json({ error: 'Enter a valid phone number' });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address' });
    }

    const allowedServices = [
      'Cardiac Consultation',
      'Heart-Health Screening',
      'Follow-up Care'
    ];
    if (!allowedServices.includes(service)) {
      return res.status(400).json({ error: 'Choose a valid service' });
    }
    if (!validDate(date) || isPastDate(date) || !validTime(time)) {
      return res.status(400).json({ error: 'Choose a valid future date and time' });
    }

    const blocked = await BlockedDate.findOne({ date }).lean();
    if (blocked) return res.status(409).json({ error: 'This date is unavailable' });

    if (!slotsFor(date).includes(time)) {
      return res.status(400).json({ error: 'This time is not available' });
    }

    const existing = await Appointment.findOne({
      date,
      time,
      status: { $ne: 'cancelled' }
    }).lean();

    if (existing) {
      return res.status(409).json({
        error: 'This slot was just booked. Please choose another time.'
      });
    }

    const reference = 'CC-' + crypto.randomBytes(5).toString('hex').toUpperCase();

    const appointment = await Appointment.create({
      reference, name, phone, email, service, date, time, message
    });

    res.status(201).json({
      success: true,
      reference: appointment.reference,
      message: 'Appointment request received. Please wait for clinic confirmation.'
    });
  } catch (error) {
    console.error('Booking error:', error.message);
    res.status(500).json({ error: 'Booking failed. Please try again.' });
  }
});

app.get('/api/appointments/:reference', async (req, res) => {
  try {
    await connectDB();
    const reference = safeText(req.params.reference, 30).toUpperCase();

    const appointment = await Appointment.findOne({ reference })
      .select('reference name service date time status createdAt')
      .lean();

    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }
    res.json({ appointment });
  } catch (error) {
    console.error('Lookup error:', error.message);
    res.status(500).json({ error: 'Unable to look up appointment' });
  }
});

app.post('/api/admin/login', loginLimiter, async (req, res) => {
  try {
    if (!ADMIN_USERNAME || !ADMIN_PASSWORD || !SESSION_SECRET) {
      return res.status(503).json({
        error: 'Configure ADMIN_USERNAME, ADMIN_PASSWORD and SESSION_SECRET'
      });
    }

    const username = safeText(req.body.username, 100);
    const password = String(req.body.password || '');

    const userMatch = crypto.timingSafeEqual(
      Buffer.from(username.padEnd(100, '\0').slice(0, 100)),
      Buffer.from(ADMIN_USERNAME.padEnd(100, '\0').slice(0, 100))
    );

    let passwordMatch = false;
    if (ADMIN_PASSWORD.startsWith('$2')) {
      passwordMatch = await bcrypt.compare(password, ADMIN_PASSWORD);
    } else {
      const submitted = crypto.createHash('sha256').update(password).digest();
      const expected = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
      passwordMatch = crypto.timingSafeEqual(submitted, expected);
    }

    if (!userMatch || !passwordMatch) {
      return res.status(401).json({ error: 'Incorrect username or password' });
    }

    res.cookie('admin_session', signToken(), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 8 * 60 * 60 * 1000,
      path: '/'
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Login error:', error.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('admin_session', { path: '/' });
  res.json({ success: true });
});

app.get('/api/admin/me', requireAdmin, (req, res) => {
  res.json({ authenticated: true, username: ADMIN_USERNAME });
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    await connectDB();

    const [total, pending, confirmed, completed, cancelled] = await Promise.all([
      Appointment.countDocuments(),
      Appointment.countDocuments({ status: 'pending' }),
      Appointment.countDocuments({ status: 'confirmed' }),
      Appointment.countDocuments({ status: 'completed' }),
      Appointment.countDocuments({ status: 'cancelled' })
    ]);

    res.json({ total, pending, confirmed, completed, cancelled });
  } catch (error) {
    console.error('Stats error:', error.message);
    res.status(500).json({ error: 'Unable to load dashboard statistics' });
  }
});

app.get('/api/admin/appointments', requireAdmin, async (req, res) => {
  try {
    await connectDB();

    const page = Math.max(1, Math.min(10000, Number(req.query.page) || 1));
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
    const status = safeText(req.query.status, 20);

    const filter = {};
    if (['pending', 'confirmed', 'completed', 'cancelled'].includes(status)) {
      filter.status = status;
    }

    const [appointments, total] = await Promise.all([
      Appointment.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Appointment.countDocuments(filter)
    ]);

    res.json({ appointments, total, page, limit });
  } catch (error) {
    console.error('Admin appointments error:', error.message);
    res.status(500).json({ error: 'Unable to load appointments' });
  }
});

app.patch('/api/admin/appointments/:id/status', requireAdmin, async (req, res) => {
  try {
    await connectDB();

    const status = safeText(req.body.status, 20);
    if (!['pending', 'confirmed', 'completed', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const appointment = await Appointment.findById(req.params.id);
    if (!appointment) return res.status(404).json({ error: 'Appointment not found' });

    if (status !== 'cancelled') {
      const conflict = await Appointment.findOne({
        _id: { $ne: appointment._id },
        date: appointment.date,
        time: appointment.time,
        status: { $ne: 'cancelled' }
      }).lean();

      if (conflict) {
        return res.status(409).json({ error: 'This slot is already occupied' });
      }
    }

    appointment.status = status;
    await appointment.save();
    res.json({ success: true, appointment });
  } catch (error) {
    console.error('Status update error:', error.message);
    res.status(500).json({ error: 'Unable to update appointment' });
  }
});

app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    await connectDB();
    const settings = await Settings.findOne({ key: 'clinic' }).lean();
    res.json({ settings: settings || {} });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load settings' });
  }
});

app.put('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    await connectDB();

    const settings = await Settings.findOneAndUpdate(
      { key: 'clinic' },
      {
        $set: {
          clinicName: safeText(req.body.clinicName, 100) || 'CardioCare',
          phone: safeText(req.body.phone, 30),
          address: safeText(req.body.address, 250),
          openingTime: validTime(req.body.openingTime) ? req.body.openingTime : '09:00',
          closingTime: validTime(req.body.closingTime) ? req.body.closingTime : '17:00'
        },
        $setOnInsert: { key: 'clinic' }
      },
      { new: true, upsert: true, runValidators: true }
    );

    res.json({ success: true, settings });
  } catch (error) {
    console.error('Settings error:', error.message);
    res.status(500).json({ error: 'Unable to save settings' });
  }
});

app.post('/api/admin/blocked-dates', requireAdmin, async (req, res) => {
  try {
    await connectDB();

    const date = safeText(req.body.date, 10);
    const reason = safeText(req.body.reason, 200);

    if (!validDate(date) || isPastDate(date)) {
      return res.status(400).json({ error: 'Choose a valid future date' });
    }

    await BlockedDate.findOneAndUpdate(
      { date },
      { $set: { reason } },
      { upsert: true, new: true, runValidators: true }
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Block date error:', error.message);
    res.status(500).json({ error: 'Unable to block date' });
  }
});

app.delete('/api/admin/blocked-dates/:date', requireAdmin, async (req, res) => {
  try {
    await connectDB();
    const date = safeText(req.params.date, 10);
    if (!validDate(date)) return res.status(400).json({ error: 'Invalid date' });

    await BlockedDate.deleteOne({ date });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Unable to unblock date' });
  }
});

const publicHTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#09243d">
<title>CardioCare | Heart & Wellness Clinic</title>
<meta name="description" content="Compassionate heart-health consultations and appointment requests.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--n:#09243d;--c:#fa686b;--i:#142b42;--m:#657487;--l:#e8edf3}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:90px}
body{margin:0;font-family:"DM Sans",sans-serif;color:var(--i);line-height:1.6}
a{text-decoration:none;color:inherit}button,input,select,textarea{font:inherit}
.wrap{width:min(1160px,91%);margin:auto}
header{height:78px;position:sticky;top:0;z-index:50;background:#ffffffef;backdrop-filter:blur(12px);border-bottom:1px solid var(--l)}
.nav{height:100%;display:flex;justify-content:space-between;align-items:center;gap:20px}
.brand{font:800 25px Manrope,sans-serif;letter-spacing:-1px}.brand b{color:var(--c)}
.brand small{display:block;font:700 9px "DM Sans",sans-serif;letter-spacing:2px;color:var(--m)}
.links{display:flex;align-items:center;gap:24px;font-size:14px;font-weight:700;color:#526478}
.btn{display:inline-flex;justify-content:center;align-items:center;gap:8px;padding:13px 20px;border:0;border-radius:12px;background:var(--c);color:white;font-weight:700;cursor:pointer;transition:.25s}
.btn:hover{transform:translateY(-2px);box-shadow:0 10px 24px #fa686b45}
.menu{display:none;border:0;background:#f1f6fb;border-radius:9px;padding:8px 12px;font-size:22px}
.hero{color:white;background:linear-gradient(120deg,#08233c,#103956 70%,#174e6c);overflow:hidden}
.hg{min-height:570px;display:grid;grid-template-columns:1fr 1fr;align-items:center;gap:38px;padding:55px 0}
.kicker{font-size:12px;letter-spacing:2px;font-weight:800;color:#ed656c}
.pill{display:inline-block;background:#ffffff12;border:1px solid #ffffff25;border-radius:30px;padding:7px 13px;color:#d7e9f8;font-size:12px;font-weight:700}
h1,h2,h3{font-family:Manrope,sans-serif}
h1{font-size:clamp(40px,5vw,64px);letter-spacing:-2px;line-height:1.1;margin:23px 0}
h1 em{font-style:normal;color:#ff7779}
.hero p{max-width:510px;color:#c9d9e7;font-size:17px;line-height:1.8}
.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:25px}
.secondary{background:transparent;border:1px solid #ffffff70}
.note{font-size:12px;color:#c9d9e7;margin-top:20px}
.visual{position:relative}.doctor{width:100%;height:450px;object-fit:cover;object-position:center 25%;border-radius:24px 24px 70px 24px;display:block}
.caption{position:absolute;bottom:18px;left:18px;right:18px;background:#ffffffed;color:var(--i);padding:15px;border-radius:14px;font-size:13px;font-weight:700}
.caption small{display:block;color:var(--m);font-weight:400}
.trust{background:#f4f8fc;border-bottom:1px solid var(--l)}
.trust-grid{display:grid;grid-template-columns:repeat(3,1fr);padding:22px 0}
.trust-item{text-align:center;border-right:1px solid #dfe7ef;font-weight:700;font-size:13px}
.trust-item:last-child{border:0}.trust-item span{display:block;color:#3988d6;font-size:23px}
.section{padding:76px 0}.heading{margin-bottom:28px}.heading h2,.about h2,.booking h2{font-size:clamp(30px,4vw,43px);letter-spacing:-1px;line-height:1.2;margin:10px 0}
.heading p,.about p{color:var(--m)}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.card{border:1px solid var(--l);border-radius:18px;padding:24px;transition:.3s;background:white}
.card:hover{transform:translateY(-6px);box-shadow:0 18px 50px #09243d12}
.icon{display:grid;place-items:center;width:52px;height:52px;border-radius:15px;background:#fff0ef;font-size:25px;margin-bottom:16px}
.card p{color:var(--m);font-size:14px;line-height:1.8}.card h3{font-size:19px}
.about{background:#f3f8fc}
.about-grid{display:grid;grid-template-columns:1fr 1fr;align-items:center;gap:48px}
.about-img{width:100%;height:360px;object-fit:cover;border-radius:22px}
.checks{display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:13px;font-weight:700;margin:24px 0}
.checks span{color:#168b70}
.booking{background:var(--n);color:white}
.booking-grid{display:grid;grid-template-columns:1fr 1fr;gap:35px;align-items:start}
.booking p{color:#c9d9e7}
form{display:grid;gap:13px}
.field{display:grid;gap:6px;font-size:13px;font-weight:700}
input,select,textarea{width:100%;padding:12px 13px;border:1px solid #dfe7ef;border-radius:10px;background:white;color:var(--i);outline:none}
input:focus,select:focus,textarea:focus{border-color:#3988d6;box-shadow:0 0 0 3px #3988d620}
textarea{min-height:85px;resize:vertical}
.form-card{background:white;color:var(--i);padding:23px;border-radius:18px}
.notice{font-size:13px;padding:12px;border-radius:10px;background:#eef8f3;color:#12684c;display:none}
footer{background:#061a2c;color:#d2dfeb;padding:32px 0}
.foot{display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap;font-size:13px}
.reveal{opacity:0;transform:translateY(18px);transition:opacity .7s,transform .7s}
.reveal.show{opacity:1;transform:translateY(0)}
@keyframes beat{50%{opacity:.45}}.beat{animation:beat 1.5s infinite}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}.reveal{opacity:1;transform:none}}
@media(max-width:800px){
 .menu{display:block}.links{display:none;position:absolute;top:72px;left:4%;right:4%;background:white;padding:20px;border-radius:14px;box-shadow:0 15px 40px #0002;flex-direction:column;align-items:stretch}
 .links.open{display:flex}.hg,.about-grid,.booking-grid{grid-template-columns:1fr}.hg{padding:45px 0}.doctor{height:370px}
 .trust-item{font-size:11px;padding:8px 3px}.cards{grid-template-columns:1fr}.section{padding:58px 0}
 .checks{grid-template-columns:1fr}.hero p{font-size:16px}
}
</style>
</head>
<body>
<header><div class="wrap nav">
<a class="brand" href="#home">♡ Cardio<b>Care</b><small>HEART & WELLNESS CLINIC</small></a>
<button class="menu" id="menu" aria-label="Toggle menu">☰</button>
<nav class="links" id="links"><a href="#home">Home</a><a href="#services">Services</a><a href="#about">About</a><a href="#booking">Appointments</a><a href="/admin">Admin</a></nav>
</div></header>

<main>
<section class="hero" id="home"><div class="wrap hg">
<div class="reveal"><span class="pill"><span class="beat">♡</span> YOUR HEART, OUR PRIORITY</span>
<h1>Expert Heart Care.<br><em>Closer to You.</em></h1>
<p>Personalized consultations, preventive screening and compassionate care designed around you.</p>
<div class="actions"><a class="btn" href="#booking">Book an Appointment →</a><a class="btn secondary" href="#about">Meet Our Team</a></div>
<div class="note">♡ &nbsp; Thoughtful care. Clear guidance. A healthier tomorrow.</div></div>
<div class="visual reveal"><img class="doctor" src="https://images.unsplash.com/photo-1612349317150-e413f6a5b16d?auto=format&fit=crop&w=1000&q=85" alt="Doctor in a clinical setting"><div class="caption">♡ &nbsp; Care that puts you first<small>Personalized heart-health support</small></div></div>
</div></section>

<div class="trust"><div class="wrap trust-grid">
<div class="trust-item"><span>♧</span>Compassionate Care</div>
<div class="trust-item"><span>♡</span>Preventive Focus</div>
<div class="trust-item"><span>✓</span>Personalized Support</div>
</div></div>

<section class="section" id="services"><div class="wrap">
<div class="heading reveal"><div class="kicker">OUR SERVICES</div><h2>Care for Every Heartbeat</h2><p>Support for your heart-health journey, at every step.</p></div>
<div class="cards">
<article class="card reveal"><div class="icon">♡</div><h3>Cardiac Consultation</h3><p>Discuss your heart-health concerns and receive personalized guidance from a qualified professional.</p><a class="kicker" href="#booking">Book a consultation →</a></article>
<article class="card reveal"><div class="icon">⌁</div><h3>Heart-Health Screening</h3><p>Learn about preventive assessments and checks that may be appropriate for your needs.</p><a class="kicker" href="#booking">Ask about screening →</a></article>
<article class="card reveal"><div class="icon">▤</div><h3>Follow-up Care</h3><p>Discuss your care plan, follow-up needs and next steps with your healthcare provider.</p><a class="kicker" href="#booking">Arrange follow-up →</a></article>
</div></div></section>

<section class="section about" id="about"><div class="wrap about-grid">
<div class="reveal"><img class="about-img" src="https://images.unsplash.com/photo-1576091160399-112ba8d25d1d?auto=format&fit=crop&w=1000&q=85" alt="Healthcare professional and patient" loading="lazy"></div>
<div class="reveal"><div class="kicker">A HEALTHIER TOMORROW</div><h2>Your heart deserves thoughtful attention.</h2>
<p>Good healthcare starts with listening. Our goal is to help you understand your options and take informed next steps with a qualified healthcare professional.</p>
<div class="checks"><div><span>✓</span> Patient-focused care</div><div><span>✓</span> Clear communication</div><div><span>✓</span> Preventive education</div><div><span>✓</span> Follow-up support</div></div>
<a class="btn" href="#booking">Plan Your Visit →</a></div>
</div></section>

<section class="section booking" id="booking"><div class="wrap booking-grid">
<div class="reveal"><div class="kicker">APPOINTMENT REQUEST</div><h2>Make time for your heart health.</h2><p>Choose your preferred date and available time to request an appointment.</p><p style="font-size:13px">Submitting a request does not mean your appointment is confirmed. The clinic will need to confirm it.</p></div>
<div class="form-card reveal">
<div id="notice" class="notice" role="status"></div>
<form id="bookingForm">
<label class="field">Full name<input name="name" required minlength="2" maxlength="100" autocomplete="name" placeholder="Your full name"></label>
<label class="field">Phone number<input name="phone" required maxlength="20" autocomplete="tel" placeholder="+91 98765 43210"></label>
<label class="field">Email (optional)<input name="email" type="email" maxlength="150" autocomplete="email" placeholder="you@example.com"></label>
<label class="field">Service<select name="service" required><option value="">Choose a service</option><option>Cardiac Consultation</option><option>Heart-Health Screening</option><option>Follow-up Care</option></select></label>
<label class="field">Appointment date<input name="date" id="date" type="date" required></label>
<label class="field">Available time<select name="time" id="time" required disabled><option value="">Select a date first</option></select></label>
<label class="field">Message (optional)<textarea name="message" maxlength="500" placeholder="Anything you would like the clinic to know"></textarea></label>
<button class="btn" id="submitBtn" type="submit">Request Appointment →</button>
</form>
</div></div></section>
</main>

<footer><div class="wrap foot"><div><strong>♡ CardioCare</strong><br>Heart care with a human touch.</div><div><a href="#services">Services</a> &nbsp; · &nbsp; <a href="#about">About</a> &nbsp; · &nbsp; <a href="/admin">Admin Login</a><br><small>© <span id="year"></span> CardioCare. Verify clinic details before publishing.</small></div></div></footer>

<script>
(function(){
const menu=document.getElementById('menu');
const links=document.getElementById('links');
menu.addEventListener('click',()=>links.classList.toggle('open'));
links.querySelectorAll('a').forEach(a=>a.addEventListener('click',()=>links.classList.remove('open')));
document.getElementById('year').textContent=new Date().getFullYear();

const observer=('IntersectionObserver' in window)?new IntersectionObserver(entries=>{
entries.forEach(entry=>{if(entry.isIntersecting){entry.target.classList.add('show');observer.unobserve(entry.target);}});
},{threshold:.12}):null;
document.querySelectorAll('.reveal').forEach(el=>observer?observer.observe(el):el.classList.add('show'));

const form=document.getElementById('bookingForm');
const dateInput=document.getElementById('date');
const timeSelect=document.getElementById('time');
const notice=document.getElementById('notice');
const submitBtn=document.getElementById('submitBtn');

const now=new Date();
const localToday=new Date(now.getTime()-now.getTimezoneOffset()*60000).toISOString().slice(0,10);
dateInput.min=localToday;

function showNotice(message,success){
notice.style.display='block';
notice.style.background=success?'#eef8f3':'#fff0ef';
notice.style.color=success?'#12684c':'#a52c37';
notice.textContent=message;
}
dateInput.addEventListener('change',async()=>{
timeSelect.disabled=true;
timeSelect.innerHTML='<option value="">Loading available times…</option>';
if(!dateInput.value)return;
try{
const response=await fetch('/api/availability?date='+encodeURIComponent(dateInput.value));
const data=await response.json();
if(!response.ok)throw new Error(data.error||'Unable to load slots');
timeSelect.innerHTML='';
if(!data.slots.length){
timeSelect.add(new Option('No slots available',''));
}else{
timeSelect.add(new Option('Choose a time',''));
data.slots.forEach(slot=>timeSelect.add(new Option(slot,slot)));
}
timeSelect.disabled=data.slots.length===0;
}catch(error){
timeSelect.innerHTML='<option value="">Could not load slots</option>';
showNotice(error.message,false);
}
});

form.addEventListener('submit',async event=>{
event.preventDefault();
notice.style.display='none';
submitBtn.disabled=true;
submitBtn.textContent='Submitting…';
try{
const payload=Object.fromEntries(new FormData(form).entries());
const response=await fetch('/api/appointments',{
method:'POST',
headers:{'Content-Type':'application/json'},
body:JSON.stringify(payload)
});
const data=await response.json();
if(!response.ok)throw new Error(data.error||'Booking failed');
form.reset();
timeSelect.innerHTML='<option value="">Select a date first</option>';
timeSelect.disabled=true;
dateInput.min=localToday;
showNotice('Request received! Your reference is '+data.reference+'. Please wait for clinic confirmation.',true);
}catch(error){showNotice(error.message,false);}
finally{submitBtn.disabled=false;submitBtn.textContent='Request Appointment →';}
});
})();
</script>
</body>
</html>`;

const adminHTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CardioCare Admin</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Manrope:wght@600;700;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box}body{margin:0;background:#f2f6fa;color:#142b42;font:15px "DM Sans",sans-serif}
main{width:min(1100px,94%);margin:35px auto}
h1,h2{font-family:Manrope,sans-serif}
.card{background:white;border:1px solid #e4ebf2;border-radius:16px;padding:22px;margin-bottom:18px;box-shadow:0 8px 30px #09243d08}
input,select,button{font:inherit;padding:11px 13px;border:1px solid #d9e2eb;border-radius:9px}
button{background:#fa686b;color:white;border:0;font-weight:700;cursor:pointer}
label{display:grid;gap:7px;margin-bottom:13px}
.login{max-width:430px;margin:70px auto}
.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}
.stat{background:#eef5fc;border-radius:12px;padding:15px}
.stat b{display:block;font-size:26px;color:#123a5b}
.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;min-width:720px}
th,td{text-align:left;border-bottom:1px solid #e8edf3;padding:12px;font-size:13px}
th{color:#657487}td select{max-width:145px}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.msg{padding:12px;background:#fff0ef;border-radius:9px;margin-bottom:12px}
@media(max-width:700px){.stats{grid-template-columns:repeat(2,1fr)}main{margin:18px auto}.card{padding:15px}}
</style>
</head>
<body><main>
<section id="loginPanel" class="card login">
<h1>♡ CardioCare</h1><p>Secure administrator sign in</p>
<div id="loginMsg" class="msg" hidden></div>
<form id="loginForm">
<label>Username<input name="username" required autocomplete="username"></label>
<label>Password<input name="password" type="password" required autocomplete="current-password"></label>
<button type="submit">Sign In</button>
</form></section>
<section id="dashboard" hidden>
<div class="row"><div><h1>Admin Dashboard</h1><p>Manage clinic appointment requests.</p></div><button id="logout">Log Out</button></div>
<div class="stats card" id="stats"></div>
<div class="card"><div class="row"><h2>Appointments</h2><select id="filter"><option value="">All statuses</option><option>pending</option><option>confirmed</option><option>completed</option><option>cancelled</option></select></div>
<div id="dashMsg"></div><div class="table-wrap"><table><thead><tr><th>Patient</th><th>Contact</th><th>Service</th><th>Date / Time</th><th>Status</th></tr></thead><tbody id="rows"></tbody></table></div>
<button id="refresh">Refresh</button></div>
</section></main>
<script>
const loginPanel=document.getElementById('loginPanel');
const dashboard=document.getElementById('dashboard');
const loginMsg=document.getElementById('loginMsg');
const dashMsg=document.getElementById('dashMsg');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(url,options={}){
const response=await fetch(url,{credentials:'same-origin',...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});
const data=await response.json().catch(()=>({}));
if(!response.ok)throw new Error(data.error||'Request failed');
return data;
}
async function load(){
const stats=await api('/api/admin/stats');
document.getElementById('stats').innerHTML=Object.entries(stats).map(([key,value])=>'<div class="stat">'+esc(key.charAt(0).toUpperCase()+key.slice(1))+'<b>'+Number(value)+'</b></div>').join('');
const result=await api('/api/admin/appointments?limit=100&status='+encodeURIComponent(document.getElementById('filter').value));
document.getElementById('rows').innerHTML=result.appointments.map(a=>'<tr><td>'+esc(a.name)+'<br><small>'+esc(a.reference)+'</small></td><td>'+esc(a.phone)+'<br>'+esc(a.email)+'</td><td>'+esc(a.service)+'</td><td>'+esc(a.date)+'<br>'+esc(a.time)+'</td><td><select data-id="'+esc(a._id)+'">'+['pending','confirmed','completed','cancelled'].map(s=>'<option '+(a.status===s?'selected':'')+'>'+s+'</option>').join('')+'</select></td></tr>').join('')||'<tr><td colspan="5">No appointments found.</td></tr>';
}
async function check(){
try{await api('/api/admin/me');loginPanel.hidden=true;dashboard.hidden=false;await load();}
catch{loginPanel.hidden=false;dashboard.hidden=true;}
}
document.getElementById('loginForm').addEventListener('submit',async e=>{
e.preventDefault();loginMsg.hidden=true;
const form=new FormData(e.target);
try{await api('/api/admin/login',{method:'POST',body:JSON.stringify({username:form.get('username'),password:form.get('password')})});e.target.reset();await check();}
catch(err){loginMsg.textContent=err.message;loginMsg.hidden=false;}
});
document.getElementById('logout').addEventListener('click',async()=>{await api('/api/admin/logout',{method:'POST'});loginPanel.hidden=false;dashboard.hidden=true;});
document.getElementById('refresh').addEventListener('click',()=>load().catch(e=>dashMsg.textContent=e.message));
document.getElementById('filter').addEventListener('change',()=>load().catch(e=>dashMsg.textContent=e.message));
document.getElementById('rows').addEventListener('change',async e=>{
if(!e.target.matches('select[data-id]'))return;
try{await api('/api/admin/appointments/'+encodeURIComponent(e.target.dataset.id)+'/status',{method:'PATCH',body:JSON.stringify({status:e.target.value})});dashMsg.textContent='Status updated.';await load();}
catch(err){dashMsg.textContent=err.message;load().catch(()=>{});}
});
check();
</script></body></html>`;

app.get('/', (req, res) => {
  res.type('html').send(publicHTML);
});

app.get('/admin', (req, res) => {
  res.type('html').send(adminHTML);
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API route not found' });
  }
  res.status(404).type('text').send('Page not found');
});

app.use((error, req, res, next) => {
  console.error('Unhandled server error:', error.message);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Internal server error' });
});

if (require.main === module) {
  connectDB()
    .then(() => {
      app.listen(PORT, () => console.log('CardioCare listening on port ' + PORT));
    })
    .catch(error => {
      console.error('Startup failed:', error.message);
      process.exit(1);
    });
}

module.exports = app;

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const adminDashboard = require('./admin.js');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURATION & SECURITY MIDDLEWARE ---
app.use(helmet({ contentSecurityPolicy: false })); // Disabled for CDN scripts
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*', credentials: true }));

const publicLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/appointments', publicLimiter);
app.use('/api/admin/login', publicLimiter);

// --- MONGODB CONNECTION (Serverless Cached) ---
let cached = global.mongoose;
if (!cached) cached = global.mongoose = { conn: null, promise: null };

async function connectDB() {
    if (cached.conn) return cached.conn;
    if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");
    if (!cached.promise) {
        cached.promise = mongoose.connect(process.env.MONGODB_URI, { bufferCommands: false })
            .then(m => m).catch(err => { throw err; });
    }
    cached.conn = await cached.promise;
    await initializeAdmin();
    return cached.conn;
}

// --- DATABASE MODELS ---
const appointmentSchema = new mongoose.Schema({
    bookingReference: { type: String, unique: true },
    patientName: { type: String, required: true },
    phone: { type: String, required: true },
    email: { type: String },
    age: { type: Number, required: true },
    consultationType: { type: String, required: true },
    visitType: { type: String, required: true },
    consultationFee: { type: Number, required: true },
    appointmentStart: { type: Date, required: true },
    appointmentEnd: { type: Date, required: true },
    status: { type: String, enum: ['pending', 'confirmed', 'completed', 'cancelled'], default: 'pending' },
    reasonForVisit: { type: String, maxlength: 500 }
}, { timestamps: true });

// Atomic index prevents double booking of active slots
appointmentSchema.index(
    { appointmentStart: 1 }, 
    { unique: true, partialFilterExpression: { status: { $in: ['pending', 'confirmed', 'completed'] } } }
);

const adminSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true }
}, { timestamps: true });

const Appointment = mongoose.models.Appointment || mongoose.model('Appointment', appointmentSchema);
const Admin = mongoose.models.Admin || mongoose.model('Admin', adminSchema);

// Auto-provision initial admin securely
async function initializeAdmin() {
    const adminCount = await Admin.countDocuments();
    if (adminCount === 0 && process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
        const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
        await Admin.create({ username: process.env.ADMIN_USERNAME, passwordHash: hash });
        console.log("Initial admin account created from environment variables.");
    }
}

// --- AUTH MIDDLEWARE ---
const requireAuth = (req, res, next) => {
    const token = req.cookies.admin_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        req.admin = jwt.verify(token, process.env.SESSION_SECRET || 'fallback-secret-for-dev');
        next();
    } catch (e) {
        res.status(401).json({ error: 'Invalid token' });
    }
};

// --- ERROR HANDLER WRAPPER ---
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// --- HELPER FUNCTIONS ---
// Generates all standard clinic slots (Mon-Sat, 9am-1pm, 4pm-7pm IST) for a given date
const getClinicSlots = (dateStr) => {
    const d = new Date(dateStr);
    if (d.getDay() === 0) return []; // Sunday Closed
    const slots = [];
    const hours = [9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 16, 16.5, 17, 17.5, 18, 18.5];
    hours.forEach(h => {
        const hh = Math.floor(h).toString().padStart(2, '0');
        const mm = (h % 1 === 0) ? '00' : '30';
        // Construct ISO string targeting Asia/Kolkata (+05:30)
        slots.push(new Date(`${dateStr}T${hh}:${mm}:00+05:30`));
    });
    return slots;
};

// Calculate pricing securely on backend
const getFee = (visitType) => visitType === 'follow-up' ? 500 : 800;

// --- API ENDPOINTS (PUBLIC) ---
app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'CardioCare API' }));

app.get('/api/availability', asyncHandler(async (req, res) => {
    await connectDB();
    const { date } = req.query;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date format (YYYY-MM-DD)' });

    const allSlots = getClinicSlots(date);
    const now = new Date();
    const validSlots = allSlots.filter(s => s > now); // Exclude past slots

    if (validSlots.length === 0) return res.json({ available: [] });

    const startOfDay = validSlots[0];
    const endOfDay = validSlots[validSlots.length - 1];

    const booked = await Appointment.find({
        appointmentStart: { $gte: startOfDay, $lte: endOfDay },
        status: { $in: ['pending', 'confirmed', 'completed'] }
    }).select('appointmentStart');

    const bookedTimes = booked.map(b => b.appointmentStart.getTime());
    const available = validSlots
        .filter(s => !bookedTimes.includes(s.getTime()))
        .map(s => {
            const parts = s.toISOString().split('T')[1].split(':'); // Get UTC time
            // Reformat locally to IST display format for user
            return s.toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit' });
        });

    res.json({ available });
}));

app.post('/api/appointments', asyncHandler(async (req, res) => {
    await connectDB();
    const { date, time, patientName, phone, email, age, consultationType, visitType, reasonForVisit } = req.body;
    
    if (!date || !time || !patientName || !phone || !age || !consultationType || !visitType) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const appointmentStart = new Date(`${date}T${time}:00+05:30`);
    if (appointmentStart < new Date()) return res.status(400).json({ error: 'Cannot book in the past' });

    const appointmentEnd = new Date(appointmentStart.getTime() + 30 * 60000);
    const bookingReference = 'CC-' + crypto.randomBytes(4).toString('hex').toUpperCase();

    try {
        const appointment = new Appointment({
            bookingReference, patientName, phone, email, age, consultationType, visitType,
            consultationFee: getFee(visitType), appointmentStart, appointmentEnd, reasonForVisit
        });
        await appointment.save();
        res.status(201).json({ success: true, bookingReference, appointmentStart });
    } catch (err) {
        if (err.code === 11000) return res.status(409).json({ error: 'This time slot was just booked by someone else. Please select another.' });
        throw err;
    }
}));

// --- API ENDPOINTS (ADMIN) ---
app.post('/api/admin/login', asyncHandler(async (req, res) => {
    await connectDB();
    const { username, password } = req.body;
    const admin = await Admin.findOne({ username });
    if (!admin || !(await bcrypt.compare(password, admin.passwordHash))) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ id: admin._id }, process.env.SESSION_SECRET || 'fallback-secret-for-dev', { expiresIn: '8h' });
    res.cookie('admin_token', token, {
        httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 8 * 60 * 60 * 1000
    });
    res.json({ success: true });
}));

app.post('/api/admin/logout', (req, res) => {
    res.clearCookie('admin_token').json({ success: true });
});

app.get('/api/admin/me', requireAuth, (req, res) => res.json({ authenticated: true }));

app.get('/api/admin/stats', requireAuth, asyncHandler(async (req, res) => {
    await connectDB();
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const todayStart = new Date(`${todayStr}T00:00:00+05:30`);
    const todayEnd = new Date(`${todayStr}T23:59:59+05:30`);

    const total = await Appointment.countDocuments();
    const pending = await Appointment.countDocuments({ status: 'pending' });
    const confirmed = await Appointment.countDocuments({ status: 'confirmed' });
    const today = await Appointment.countDocuments({ appointmentStart: { $gte: todayStart, $lte: todayEnd }});

    res.json({ total, pending, confirmed, today });
}));

app.get('/api/admin/appointments', requireAuth, asyncHandler(async (req, res) => {
    await connectDB();
    const { status, date } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (date) {
        const start = new Date(`${date}T00:00:00+05:30`);
        const end = new Date(`${date}T23:59:59+05:30`);
        filter.appointmentStart = { $gte: start, $lte: end };
    }
    const appointments = await Appointment.find(filter).sort({ appointmentStart: -1 }).limit(100);
    res.json({ appointments });
}));

app.patch('/api/admin/appointments/:id/status', requireAuth, asyncHandler(async (req, res) => {
    await connectDB();
    const { status } = req.body;
    const allowed = ['pending', 'confirmed', 'completed', 'cancelled'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    
    const apt = await Appointment.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!apt) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, appointment: apt });
}));

// --- GLOBAL ERROR HANDLER ---
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal Server Error' });
});

// --- PUBLIC UI GENERATOR ---
const generatePublicUI = () => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CardioCare | Premium Heart & Wellness Clinic</title>
    <meta name="description" content="Book your cardiology appointment with Dr. Aarav Mehta at CardioCare Heart & Wellness Clinic in Pune.">
    <script src="https://unpkg.com/lucide@latest"></script>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --coral: #FF6B6B; --coral-hover: #ff5252; --navy: #24324A;
            --mint: #BDF3DE; --sky: #BDE5FF; --lavender: #DCCBFF;
            --cream: #FFF8F0; --peach: #FFD6C9; --white: #FFFFFF;
            --text: #344054; --text-light: #667085;
            --clay-bg: #FFF8F0;
            --clay-shadow: 8px 8px 16px rgba(189, 182, 175, 0.4), -8px -8px 16px rgba(255, 255, 255, 0.9);
            --clay-inset: inset 2px 2px 5px rgba(255, 255, 255, 0.9), inset -2px -2px 5px rgba(0, 0, 0, 0.04);
            --transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Plus Jakarta Sans', sans-serif; background-color: var(--cream); color: var(--text); line-height: 1.6; overflow-x: hidden; }
        h1, h2, h3, h4 { font-family: 'Manrope', sans-serif; color: var(--navy); }
        
        .clay-card {
            background: var(--clay-bg); border-radius: 24px;
            box-shadow: var(--clay-shadow), var(--clay-inset);
            padding: 32px; border: 2px solid rgba(255,255,255,0.6);
            transition: var(--transition);
        }
        .clay-card:hover { transform: translateY(-5px); }
        
        .clay-btn {
            background: var(--coral); color: white; border: none; border-radius: 9999px;
            padding: 14px 28px; font-size: 1rem; font-weight: 700; cursor: pointer;
            box-shadow: 4px 4px 10px rgba(255, 107, 107, 0.3), -4px -4px 10px rgba(255, 255, 255, 0.8), inset 2px 2px 4px rgba(255, 255, 255, 0.3);
            transition: var(--transition); display: inline-flex; align-items: center; gap: 8px; text-decoration: none;
        }
        .clay-btn:hover { background: var(--coral-hover); transform: scale(1.02); }
        .clay-btn:active { box-shadow: inset 4px 4px 8px rgba(0,0,0,0.1), inset -4px -4px 8px rgba(255,255,255,0.4); transform: scale(0.98); }
        .clay-btn.secondary { background: var(--sky); color: var(--navy); box-shadow: 4px 4px 10px rgba(189, 229, 255, 0.5), -4px -4px 10px rgba(255, 255, 255, 0.8); }

        .clay-input {
            width: 100%; padding: 14px 20px; border-radius: 16px; border: 2px solid transparent;
            background: rgba(255, 255, 255, 0.5); font-family: inherit; font-size: 1rem;
            box-shadow: inset 4px 4px 8px rgba(0,0,0,0.05), inset -4px -4px 8px rgba(255,255,255,0.8);
            transition: var(--transition); color: var(--navy); margin-bottom: 16px;
        }
        .clay-input:focus { outline: none; border-color: var(--sky); background: var(--white); }

        .container { max-width: 1200px; margin: 0 auto; padding: 0 24px; }
        
        /* Navbar */
        nav { position: sticky; top: 16px; z-index: 100; margin: 0 24px; }
        .nav-inner { 
            background: rgba(255, 248, 240, 0.85); backdrop-filter: blur(12px); border-radius: 9999px;
            display: flex; justify-content: space-between; align-items: center; padding: 12px 24px;
            box-shadow: var(--clay-shadow); border: 1px solid rgba(255,255,255,0.5);
        }
        .logo { font-family: 'Manrope', sans-serif; font-weight: 800; font-size: 1.5rem; color: var(--coral); display: flex; align-items: center; gap: 8px; text-decoration: none;}
        .nav-links { display: flex; gap: 24px; list-style: none; }
        .nav-links a { text-decoration: none; color: var(--navy); font-weight: 600; transition: var(--transition); }
        .nav-links a:hover { color: var(--coral); }
        
        /* Hero */
        .hero { display: grid; grid-template-columns: 1fr 1fr; gap: 48px; align-items: center; padding: 80px 0; position: relative; }
        .hero h1 { font-size: 3.5rem; line-height: 1.2; margin-bottom: 24px; }
        .hero p { font-size: 1.125rem; color: var(--text-light); margin-bottom: 32px; }
        .hero-img-box { position: relative; border-radius: 40px; overflow: hidden; box-shadow: var(--clay-shadow); border: 4px solid var(--white); aspect-ratio: 4/5;}
        .hero-img-box img { width: 100%; height: 100%; object-fit: cover; }
        .floating-badge { position: absolute; background: rgba(255,255,255,0.9); backdrop-filter: blur(8px); padding: 16px; border-radius: 20px; box-shadow: var(--clay-shadow); display: flex; align-items: center; gap: 12px; animation: float 4s ease-in-out infinite; }
        .badge-1 { bottom: 40px; left: -30px; }
        .badge-2 { top: 40px; right: -30px; animation-delay: 1s; }

        @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-15px); } }

        /* Sections */
        section { padding: 80px 0; }
        .section-header { text-align: center; margin-bottom: 48px; }
        .section-header h2 { font-size: 2.5rem; margin-bottom: 16px; }
        .grid-3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 32px; }
        
        /* Services */
        .service-card { text-align: center; }
        .icon-box { width: 64px; height: 64px; background: var(--lavender); border-radius: 20px; display: flex; align-items: center; justify-content: center; margin: 0 auto 24px; box-shadow: var(--clay-inset); color: var(--navy); }
        
        /* Booking Form */
        #booking-section { background: linear-gradient(135deg, rgba(189,243,222,0.3) 0%, rgba(220,203,255,0.3) 100%); border-radius: 40px; padding: 64px 32px; }
        .booking-container { max-width: 800px; margin: 0 auto; }
        .step { display: none; animation: fadeIn 0.5s ease; }
        .step.active { display: block; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        
        .radio-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
        .radio-card { background: var(--white); border-radius: 16px; padding: 16px; text-align: center; cursor: pointer; border: 2px solid transparent; box-shadow: var(--clay-shadow); transition: var(--transition); }
        .radio-card.selected { border-color: var(--coral); background: var(--peach); box-shadow: inset 2px 2px 5px rgba(0,0,0,0.05); }
        
        .slot-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 12px; margin-top: 24px; }
        .slot { background: var(--white); padding: 12px; border-radius: 12px; text-align: center; cursor: pointer; font-weight: 600; transition: var(--transition); box-shadow: var(--clay-shadow); }
        .slot:hover { transform: translateY(-2px); }
        .slot.selected { background: var(--coral); color: white; }
        
        .progress { display: flex; justify-content: space-between; margin-bottom: 32px; position: relative; }
        .progress::before { content: ''; position: absolute; top: 50%; left: 0; right: 0; height: 4px; background: var(--white); z-index: 0; border-radius: 2px; }
        .dot { width: 32px; height: 32px; border-radius: 50%; background: var(--white); display: flex; align-items: center; justify-content: center; font-weight: bold; z-index: 1; box-shadow: var(--clay-shadow); color: var(--text-light); transition: var(--transition); }
        .dot.active { background: var(--coral); color: white; }

        /* Footer */
        footer { background: var(--navy); color: var(--white); padding: 64px 0 24px; border-top-left-radius: 40px; border-top-right-radius: 40px; }
        footer a { color: var(--sky); text-decoration: none; }
        
        /* Mobile */
        @media(max-width: 768px) {
            .hero { grid-template-columns: 1fr; }
            .hero h1 { font-size: 2.5rem; }
            .nav-links { display: none; }
            .floating-badge { display: none; }
            .radio-grid { grid-template-columns: 1fr; }
        }
        @media (prefers-reduced-motion: reduce) {
            * { animation: none !important; transition: none !important; }
        }
    </style>
</head>
<body>
    <nav>
        <div class="nav-inner">
            <a href="#" class="logo"><i data-lucide="heart-pulse"></i> CardioCare</a>
            <ul class="nav-links">
                <li><a href="#about">About Doctor</a></li>
                <li><a href="#services">Services</a></li>
                <li><a href="#health">Heart Health</a></li>
                <li><a href="#contact">Contact</a></li>
            </ul>
            <a href="#booking-section" class="clay-btn" style="padding: 10px 20px; font-size: 0.9rem;">Book Now</a>
        </div>
    </nav>

    <div class="container">
        <header class="hero">
            <div>
                <span style="background: var(--peach); color: var(--coral); padding: 6px 16px; border-radius: 20px; font-weight: 700; font-size: 0.875rem; margin-bottom: 16px; display: inline-block;">Your Heart, Our Priority</span>
                <h1>A Healthier Heart Starts With the Right Care.</h1>
                <p>Personalized cardiac consultations, preventive screening, and comprehensive heart-health management by leading specialists.</p>
                <div style="di// --- GLOBAL ERROR HANDLER ---
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal Server Error' });
});

// --- PUBLIC UI GENERATOR ---
const generatePublicUI = () => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CardioCare | Premium Heart & Wellness Clinic</title>
    <meta name="description" content="Book your cardiology appointment with Dr. Aarav Mehta at CardioCare Heart & Wellness Clinic in Pune.">
    <script src="https://unpkg.com/lucide@latest"></script>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --coral: #FF6B6B; --coral-hover: #ff5252; --navy: #24324A;
            --mint: #BDF3DE; --sky: #BDE5FF; --lavender: #DCCBFF;
            --cream: #FFF8F0; --peach: #FFD6C9; --white: #FFFFFF;
            --text: #344054; --text-light: #667085;
            --clay-bg: #FFF8F0;
            --clay-shadow: 8px 8px 16px rgba(189, 182, 175, 0.4), -8px -8px 16px rgba(255, 255, 255, 0.9);
            --clay-inset: inset 2px 2px 5px rgba(255, 255, 255, 0.9), inset -2px -2px 5px rgba(0, 0, 0, 0.04);
            --transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Plus Jakarta Sans', sans-serif; background-color: var(--cream); color: var(--text); line-height: 1.6; overflow-x: hidden; }
        h1, h2, h3, h4 { font-family: 'Manrope', sans-serif; color: var(--navy); }
        
        .clay-card {
            background: var(--clay-bg); border-radius: 24px;
            box-shadow: var(--clay-shadow), var(--clay-inset);
            padding: 32px; border: 2px solid rgba(255,255,255,0.6);
            transition: var(--transition);
        }
        .clay-card:hover { transform: translateY(-5px); }
        
        .clay-btn {
            background: var(--coral); color: white; border: none; border-radius: 9999px;
            padding: 14px 28px; font-size: 1rem; font-weight: 700; cursor: pointer;
            box-shadow: 4px 4px 10px rgba(255, 107, 107, 0.3), -4px -4px 10px rgba(255, 255, 255, 0.8), inset 2px 2px 4px rgba(255, 255, 255, 0.3);
            transition: var(--transition); display: inline-flex; align-items: center; gap: 8px; text-decoration: none;
        }
        .clay-btn:hover { background: var(--coral-hover); transform: scale(1.02); }
        .clay-btn:active { box-shadow: inset 4px 4px 8px rgba(0,0,0,0.1), inset -4px -4px 8px rgba(255,255,255,0.4); transform: scale(0.98); }
        .clay-btn.secondary { background: var(--sky); color: var(--navy); box-shadow: 4px 4px 10px rgba(189, 229, 255, 0.5), -4px -4px 10px rgba(255, 255, 255, 0.8); }

        .clay-input {
            width: 100%; padding: 14px 20px; border-radius: 16px; border: 2px solid transparent;
            background: rgba(255, 255, 255, 0.5); font-family: inherit; font-size: 1rem;
            box-shadow: inset 4px 4px 8px rgba(0,0,0,0.05), inset -4px -4px 8px rgba(255,255,255,0.8);
            transition: var(--transition); color: var(--navy); margin-bottom: 16px;
        }
        .clay-input:focus { outline: none; border-color: var(--sky); background: var(--white); }

        .container { max-width: 1200px; margin: 0 auto; padding: 0 24px; }
        
        /* Navbar */
        nav { position: sticky; top: 16px; z-index: 100; margin: 0 24px; }
        .nav-inner { 
            background: rgba(255, 248, 240, 0.85); backdrop-filter: blur(12px); border-radius: 9999px;
            display: flex; justify-content: space-between; align-items: center; padding: 12px 24px;
            box-shadow: var(--clay-shadow); border: 1px solid rgba(255,255,255,0.5);
        }
        .logo { font-family: 'Manrope', sans-serif; font-weight: 800; font-size: 1.5rem; color: var(--coral); display: flex; align-items: center; gap: 8px; text-decoration: none;}
        .nav-links { display: flex; gap: 24px; list-style: none; }
        .nav-links a { text-decoration: none; color: var(--navy); font-weight: 600; transition: var(--transition); }
        .nav-links a:hover { color: var(--coral); }
        
        /* Hero */
        .hero { display: grid; grid-template-columns: 1fr 1fr; gap: 48px; align-items: center; padding: 80px 0; position: relative; }
        .hero h1 { font-size: 3.5rem; line-height: 1.2; margin-bottom: 24px; }
        .hero p { font-size: 1.125rem; color: var(--text-light); margin-bottom: 32px; }
        .hero-img-box { position: relative; border-radius: 40px; overflow: hidden; box-shadow: var(--clay-shadow); border: 4px solid var(--white); aspect-ratio: 4/5;}
        .hero-img-box img { width: 100%; height: 100%; object-fit: cover; }
        .floating-badge { position: absolute; background: rgba(255,255,255,0.9); backdrop-filter: blur(8px); padding: 16px; border-radius: 20px; box-shadow: var(--clay-shadow); display: flex; align-items: center; gap: 12px; animation: float 4s ease-in-out infinite; }
        .badge-1 { bottom: 40px; left: -30px; }
        .badge-2 { top: 40px; right: -30px; animation-delay: 1s; }

        @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-15px); } }

        /* Sections */
        section { padding: 80px 0; }
        .section-header { text-align: center; margin-bottom: 48px; }
        .section-header h2 { font-size: 2.5rem; margin-bottom: 16px; }
        .grid-3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 32px; }
        
        /* Services */
        .service-card { text-align: center; }
        .icon-box { width: 64px; height: 64px; background: var(--lavender); border-radius: 20px; display: flex; align-items: center; justify-content: center; margin: 0 auto 24px; box-shadow: var(--clay-inset); color: var(--navy); }
        
        /* Booking Form */
        #booking-section { background: linear-gradient(135deg, rgba(189,243,222,0.3) 0%, rgba(220,203,255,0.3) 100%); border-radius: 40px; padding: 64px 32px; }
        .booking-container { max-width: 800px; margin: 0 auto; }
        .step { display: none; animation: fadeIn 0.5s ease; }
        .step.active { display: block; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        
        .radio-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
        .radio-card { background: var(--white); border-radius: 16px; padding: 16px; text-align: center; cursor: pointer; border: 2px solid transparent; box-shadow: var(--clay-shadow); transition: var(--transition); }
        .radio-card.selected { border-color: var(--coral); background: var(--peach); box-shadow: inset 2px 2px 5px rgba(0,0,0,0.05); }
        
        .slot-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 12px; margin-top: 24px; }
        .slot { background: var(--white); padding: 12px; border-radius: 12px; text-align: center; cursor: pointer; font-weight: 600; transition: var(--transition); box-shadow: var(--clay-shadow); }
        .slot:hover { transform: translateY(-2px); }
        .slot.selected { background: var(--coral); color: white; }
        
        .progress { display: flex; justify-content: space-between; margin-bottom: 32px; position: relative; }
        .progress::before { content: ''; position: absolute; top: 50%; left: 0; right: 0; height: 4px; background: var(--white); z-index: 0; border-radius: 2px; }
        .dot { width: 32px; height: 32px; border-radius: 50%; background: var(--white); display: flex; align-items: center; justify-content: center; font-weight: bold; z-index: 1; box-shadow: var(--clay-shadow); color: var(--text-light); transition: var(--transition); }
        .dot.active { background: var(--coral); color: white; }

        /* Footer */
        footer { background: var(--navy); color: var(--white); padding: 64px 0 24px; border-top-left-radius: 40px; border-top-right-radius: 40px; }
        footer a { color: var(--sky); text-decoration: none; }
        
        /* Mobile */
        @media(max-width: 768px) {
            .hero { grid-template-columns: 1fr; }
            .hero h1 { font-size: 2.5rem; }
            .nav-links { display: none; }
            .floating-badge { display: none; }
            .radio-grid { grid-template-columns: 1fr; }
        }
        @media (prefers-reduced-motion: reduce) {
            * { animation: none !important; transition: none !important; }
        }
    </style>
</head>
<body>
    <nav>
        <div class="nav-inner">
            <a href="#" class="logo"><i data-lucide="heart-pulse"></i> CardioCare</a>
            <ul class="nav-links">
                <li><a href="#about">About Doctor</a></li>
                <li><a href="#services">Services</a></li>
                <li><a href="#health">Heart Health</a></li>
                <li><a href="#contact">Contact</a></li>
            </ul>
            <a href="#booking-section" class="clay-btn" style="padding: 10px 20px; font-size: 0.9rem;">Book Now</a>
        </div>
    </nav>

    <div class="container">
        <header class="hero">
            <div>
                <span style="background: var(--peach); color: var(--coral); padding: 6px 16px; border-radius: 20px; font-weight: 700; font-size: 0.875rem; margin-bottom: 16px; display: inline-block;">Your Heart, Our Priority</span>
                <h1>A Healthier Heart Starts With the Right Care.</h1>
                <p>Personalized cardiac consultations, preventive screening, and comprehensive heart-health management by leading specialists.</p>
                <div style="di

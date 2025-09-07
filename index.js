// index.js
const mqtt = require('mqtt');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

/* =========================================================
 * MongoDB
 * =======================================================*/
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log('[BOOT] MongoDB connection established'))
  .catch((err) => console.error('[BOOT] MongoDB connection error:', err));

/* === Users (auth) === */
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, index: true },
  password: { type: String, required: true },
});
const User = mongoose.model('User', userSchema);

/* === EnrollRequest (pending card assignment) ===
 * Device polls these records. When a card is presented, the device completes the request.
 * TTL index auto-expires stale requests (default: 12h).
 */
const enrollRequestSchema = new mongoose.Schema(
  {
    deviceId: { type: String, required: true, index: true },
    fullName: { type: String, required: true },
    status: { type: String, enum: ['pending', 'completed', 'cancelled'], default: 'pending', index: true },
    requestedAt: { type: Date, required: true, default: () => new Date() },
    expiresAt: { type: Date, required: true }, // used by TTL index
    completedAt: { type: Date },
    notes: { type: String },
  },
  { timestamps: true }
);
// TTL index (expiresAt). Mongo will purge automatically.
enrollRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const EnrollRequest = mongoose.model('EnrollRequest', enrollRequestSchema);

/* === AuthorizedCard (final mapping) ===
 * Persisted after a request is completed by device.
 */
const authorizedCardSchema = new mongoose.Schema(
  {
    deviceId: { type: String, required: true, index: true },
    uid: { type: String, required: true }, // store as plain hex '03CA3D29DD'
    ownerName: { type: String, required: true },
    createdAt: { type: Date, default: () => new Date() },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
authorizedCardSchema.index({ deviceId: 1, uid: 1 }, { unique: true });
const AuthorizedCard = mongoose.model('AuthorizedCard', authorizedCardSchema);

/* =========================================================
 * MQTT message logging (kept as-is)
 * =======================================================*/
const logFilePath = 'mqtt_log.json';
let mqttMessages = [];

if (fs.existsSync(logFilePath)) {
  try {
    const data = fs.readFileSync(logFilePath, 'utf8');
    mqttMessages = JSON.parse(data);
    console.log(`[BOOT] Loaded ${mqttMessages.length} MQTT messages from file`);
  } catch (err) {
    console.error('[BOOT] Failed to read MQTT log file:', err);
  }
}

const brokerUrl = process.env.MQTT_WS_URL || 'ws://52.29.86.137:8000/mqtt';
const client = mqtt.connect(brokerUrl, {
  protocol: 'ws',
  reconnectPeriod: 2000,
});

client.on('connect', () => {
  console.log('[MQTT] Connected to broker');
  client.subscribe('stm32/demo', (err) => {
    if (err) console.error('[MQTT] Subscribe error:', err);
    else console.log('[MQTT] Subscribed topic: stm32/demo');
  });
});

client.on('message', (topic, message) => {
  const data = {
    topic,
    message: message.toString(),
    time: new Date().toISOString(),
  };

  mqttMessages.push(data);

  fs.writeFile(logFilePath, JSON.stringify(mqttMessages, null, 2), (err) => {
    if (err) console.error('[MQTT] Failed to persist message:', err);
  });
});

/* MQTT API (unchanged) */
app.get('/api/messages', (req, res) => res.json(mqttMessages));

app.delete('/api/messages', (req, res) => {
  mqttMessages = [];
  fs.writeFile(logFilePath, JSON.stringify(mqttMessages, null, 2), (err) => {
    if (err) {
      console.error('[MQTT] Failed to clear messages file:', err);
      return res.status(500).json({ success: false, error: 'Failed to clear messages file' });
    }
    console.log('[MQTT] Message log cleared');
    return res.json({ success: true });
  });
});

/* =========================================================
 * Reporting via email (kept as-is)
 * =======================================================*/
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});

app.post('/report/history', async (req, res) => {
  try {
    const { to, items } = req.body;
    if (!to || !Array.isArray(items)) return res.status(400).json({ success: false, error: 'Invalid payload: { to, items[] } required' });

    const rows = items
      .map(
        (it, i) => `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${i + 1}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${it.person || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${it.level || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${it.fillTime || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${it.levelTime || '-'}</td>
      </tr>`
      )
      .join('');

    const html = `
      <div style="font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0b1220;">
        <h2 style="margin:0 0 4px 0;">Device History Report</h2>
        <div style="color:#64748b;margin-bottom:16px;">Smart Soap Dispenser</div>
        <table style="border-collapse:collapse;width:100%;font-size:14px;">
          <thead>
            <tr style="text-align:left;background:#f8fafc;">
              <th style="padding:10px;border-bottom:1px solid #e5e7eb;">#</th>
              <th style="padding:10px;border-bottom:1px solid #e5e7eb;">Person</th>
              <th style="padding:10px;border-bottom:1px solid #e5e7eb;">Level</th>
              <th style="padding:10px;border-bottom:1px solid #e5e7eb;">Fill Time</th>
              <th style="padding:10px;border-bottom:1px solid #e5e7eb;">Level Time</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <div style="margin-top:16px;color:#64748b;">Report generated at ${new Date().toISOString()}</div>
      </div>
    `;

    await transporter.sendMail({
      from: `Smart Soap Dispenser <${process.env.EMAIL_USER}>`,
      to,
      subject: 'Device History Report',
      html,
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('[REPORT] Failed to send history email:', err);
    return res.status(500).json({ success: false, error: 'Failed to send history report email' });
  }
});

/* =========================================================
 * Auth (kept as-is)
 * =======================================================*/
let verificationCodes = {};
let passwordResetCodes = {};

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

app.post('/send-code', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ error: 'This email is already registered' });
  } catch {
    return res.status(500).json({ error: 'Failed to check user existence' });
  }

  const code = generateCode();
  verificationCodes[email] = code;

  try {
    await transporter.sendMail({
      from: `Smart Soap Dispenser <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Email Verification Code',
      text: `Your verification code is: ${code}`,
    });
    console.log(`[AUTH] Registration code sent to ${email}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[AUTH] Failed to send registration code:', err);
    res.status(500).json({ error: 'Failed to send verification code' });
  }
});

app.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'This email is not registered' });

    const code = generateCode();
    passwordResetCodes[email] = code;

    await transporter.sendMail({
      from: `Smart Soap Dispenser <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Password Reset Code',
      text: `Your password reset code is: ${code}`,
    });

    console.log(`[AUTH] Password reset code sent to ${email}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[AUTH] Failed to send password reset code:', err);
    res.status(500).json({ error: 'Failed to send password reset code' });
  }
});

app.post('/verify-reset-code', async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Email and code are required' });

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'This email is not registered' });

    const expectedCode = passwordResetCodes[email];
    if (!expectedCode) return res.status(400).json({ error: 'No reset code found or it has expired' });
    if (expectedCode !== code) return res.status(400).json({ error: 'Invalid reset code' });

    delete passwordResetCodes[email];
    console.log(`[AUTH] Reset code verified for ${email}`);
    return res.json({ success: true });
  } catch (err) {
    console.error('[AUTH] Error verifying reset code:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/register', async (req, res) => {
  const { email, password } = req.body;
  try {
    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ error: 'Email already registered' });

    const hashed = await bcrypt.hash(password, 10);
    await new User({ email, password: hashed }).save();
    console.log(`[AUTH] Registered ${email}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[AUTH] Registration error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: 'Invalid email or password' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(400).json({ error: 'Invalid email or password' });

    console.log(`[AUTH] Login OK: ${email}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[AUTH] Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/reset-password', async (req, res) => {
  const { email, newPassword } = req.body;
  if (!email || !newPassword) return res.status(400).json({ error: 'Email and new password are required' });

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'This email is not registered' });

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    console.log(`[AUTH] Password reset: ${email}`);
    return res.json({ success: true });
  } catch (err) {
    console.error('[AUTH] Reset error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* =========================================================
 * RFID Enroll API
 * =======================================================*/

/**
 * Create a new pending enroll request.
 * Body: { fullName: string, deviceId: string, ttlHours?: number }
 */
app.post('/api/v1/enroll/requests', async (req, res) => {
  try {
    const { fullName, deviceId, ttlHours } = req.body || {};
    if (!fullName || !deviceId) {
      return res.status(400).json({ success: false, error: 'fullName and deviceId are required' });
    }

    // Avoid duplicates: if there is an active pending for this device and name, reuse it
    const now = new Date();
    const ttl = Math.max(1, Math.min(24, Number(ttlHours) || 6)); // clamp 1..24
    const expiresAt = new Date(now.getTime() + ttl * 60 * 60 * 1000);

    // Optionally cancel other pendings for same device to keep queue short:
    await EnrollRequest.updateMany({ deviceId, status: 'pending' }, { $set: { status: 'cancelled' } });

    const doc = await EnrollRequest.create({
      deviceId,
      fullName,
      requestedAt: now,
      expiresAt,
      status: 'pending',
    });

    console.log(`[ENROLL] Pending created device=${deviceId} name="${fullName}" id=${doc._id.toString()}`);
    return res.json({ success: true, requestId: doc._id.toString(), expiresAt });
  } catch (err) {
    console.error('[ENROLL] Create error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create enroll request' });
  }
});

/**
 * Device polling endpoint.
 * Query: ?deviceId=XYZ
 * Returns the newest active pending request (or null).
 */
app.get('/api/v1/enroll/requests', async (req, res) => {
  try {
    const deviceId = String(req.query.deviceId || '');
    if (!deviceId) return res.status(400).json({ success: false, error: 'deviceId is required' });

    const doc = await EnrollRequest.findOne({ deviceId, status: 'pending', expiresAt: { $gt: new Date() } })
      .sort({ createdAt: -1 })
      .lean();

    if (!doc) return res.json({ success: true, request: null });

    console.log(`[ENROLL] Device poll device=${deviceId} → pending id=${doc._id}`);
    return res.json({
      success: true,
      request: {
        id: doc._id,
        fullName: doc.fullName,
        requestedAt: doc.requestedAt,
        expiresAt: doc.expiresAt,
      },
    });
  } catch (err) {
    console.error('[ENROLL] Poll error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch enroll request' });
  }
});

/**
 * Complete an enroll: device posts UID after reading a card.
 * Body: { deviceId: string, requestId: string, uid: string }  // uid as HEX without spaces
 */
app.post('/api/v1/enroll/complete', async (req, res) => {
  try {
    const { deviceId, requestId, uid } = req.body || {};
    if (!deviceId || !requestId || !uid) {
      return res.status(400).json({ success: false, error: 'deviceId, requestId and uid are required' });
    }

    // Normalize UID (e.g., "03 CA 3D 29 DD" → "03CA3D29DD")
    const normalizedUid = String(uid).replace(/\s+/g, '').toUpperCase();
    if (!/^[0-9A-F]+$/.test(normalizedUid) || normalizedUid.length < 8) {
      return res.status(400).json({ success: false, error: 'Invalid uid format' });
    }

    const reqDoc = await EnrollRequest.findOne({ _id: requestId, deviceId });
    if (!reqDoc) return res.status(404).json({ success: false, error: 'Enroll request not found' });
    if (reqDoc.status !== 'pending') return res.status(400).json({ success: false, error: 'Enroll request is not pending' });
    if (reqDoc.expiresAt <= new Date()) return res.status(400).json({ success: false, error: 'Enroll request expired' });

    // Upsert authorized card (idempotent for same device+uid)
    const card = await AuthorizedCard.findOneAndUpdate(
      { deviceId, uid: normalizedUid },
      { deviceId, uid: normalizedUid, ownerName: reqDoc.fullName, revokedAt: null },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    // Mark request completed
    reqDoc.status = 'completed';
    reqDoc.completedAt = new Date();
    await reqDoc.save();

    console.log(`[ENROLL] Completed device=${deviceId} uid=${normalizedUid} owner="${reqDoc.fullName}" cardId=${card._id}`);
    return res.json({ success: true, cardId: card._id.toString() });
  } catch (err) {
    console.error('[ENROLL] Complete error:', err);
    return res.status(500).json({ success: false, error: 'Failed to complete enroll' });
  }
});

/**
 * List authorized cards per device (for UI).
 * GET /api/v1/cards?deviceId=XYZ
 */
app.get('/api/v1/cards', async (req, res) => {
  try {
    const deviceId = String(req.query.deviceId || '');
    if (!deviceId) return res.status(400).json({ success: false, error: 'deviceId is required' });

    const rows = await AuthorizedCard.find({ deviceId, revokedAt: null }).sort({ createdAt: -1 }).lean();
    return res.json({ success: true, items: rows });
  } catch (err) {
    console.error('[CARDS] List error:', err);
    return res.status(500).json({ success: false, error: 'Failed to list cards' });
  }
});

/**
 * Revoke a card.
 * POST /api/v1/cards/revoke  { deviceId, uid }
 */
app.post('/api/v1/cards/revoke', async (req, res) => {
  try {
    const { deviceId, uid } = req.body || {};
    if (!deviceId || !uid) return res.status(400).json({ success: false, error: 'deviceId and uid are required' });

    const normalizedUid = String(uid).replace(/\s+/g, '').toUpperCase();
    const card = await AuthorizedCard.findOne({ deviceId, uid: normalizedUid });
    if (!card) return res.status(404).json({ success: false, error: 'Card not found' });
    if (card.revokedAt) return res.json({ success: true, alreadyRevoked: true });

    card.revokedAt = new Date();
    await card.save();

    console.log(`[CARDS] Revoked device=${deviceId} uid=${normalizedUid}`);
    return res.json({ success: true });
  } catch (err) {
    console.error('[CARDS] Revoke error:', err);
    return res.status(500).json({ success: false, error: 'Failed to revoke card' });
  }
});

/* =========================================================
 * HTTP Server
 * =======================================================*/
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[BOOT] HTTP server listening on ${PORT}`);
});

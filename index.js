// index.js
const mqtt = require('mqtt');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const { randomUUID } = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// -------------------------------------------------------
// Common response helpers
// -------------------------------------------------------
app.use((req, res, next) => {
  // Correlation Id
  const cid = req.headers['x-correlation-id'] || randomUUID();
  res.locals.correlationId = cid;
  res.setHeader('x-correlation-id', cid);
  next();
});

function ok(res, {
  action,
  resource,
  code,
  message = 'OK',
  data = {},
  status = 200,
  legacy = {}, // { success, request, items, ... } legacy alanlar için
}) {
  const payload = {
    ok: true,
    status,
    action,
    resource,
    code,
    message,
    correlationId: res.locals.correlationId,
    ts: new Date().toISOString(),
    data,
    ...legacy,
  };
  return res.status(status).json(payload);
}

function fail(res, {
  action,
  resource,
  code,
  message = 'Error',
  status = 400,
  error,
  data = {},
  legacy = {},
}) {
  const payload = {
    ok: false,
    status,
    action,
    resource,
    code,
    message,
    correlationId: res.locals.correlationId,
    ts: new Date().toISOString(),
    error: error ? String(error) : undefined,
    data,
    ...legacy,
  };
  return res.status(status).json(payload);
}

// -------------------------------------------------------
// MongoDB
// -------------------------------------------------------
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log('[BOOT] MongoDB connection established'))
  .catch((err) => console.error('[BOOT] MongoDB connection error:', err));

// === Users (auth) ===
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, index: true },
  password: { type: String, required: true },
});
const User = mongoose.model('User', userSchema);

// === EnrollRequest (pending card assignment)
const enrollRequestSchema = new mongoose.Schema(
  {
    deviceId: { type: String, required: true, index: true },
    fullName: { type: String, required: true },
    status: { type: String, enum: ['pending', 'completed', 'cancelled'], default: 'pending', index: true },
    requestedAt: { type: Date, required: true, default: () => new Date() },
    expiresAt: { type: Date, required: true },
    completedAt: { type: Date },
    notes: { type: String },
  },
  { timestamps: true }
);
enrollRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const EnrollRequest = mongoose.model('EnrollRequest', enrollRequestSchema);

// === AuthorizedCard (final mapping)
const authorizedCardSchema = new mongoose.Schema(
  {
    deviceId: { type: String, required: true, index: true },
    uid: { type: String, required: true }, // hex "03CA3D29DD"
    ownerName: { type: String, required: true },
    createdAt: { type: Date, default: () => new Date() },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
authorizedCardSchema.index({ deviceId: 1, uid: 1 }, { unique: true });
const AuthorizedCard = mongoose.model('AuthorizedCard', authorizedCardSchema);

// -------------------------------------------------------
// MQTT message logging (kept as-is in behavior)
// -------------------------------------------------------
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

// MQTT API
app.get('/api/messages', (req, res) => {
  return ok(res, {
    action: 'list',
    resource: 'mqtt.messages',
    code: 'MQTT_MESSAGES_LIST_OK',
    data: { items: mqttMessages },
    legacy: {
      success: true,
      // geriye dönük isteyenler doğrudan diziyi bekliyorsa:
      // ama mevcut uygulaman sen JSON bekliyor → items içinden alınabilir.
    },
  });
});

app.delete('/api/messages', (req, res) => {
  mqttMessages = [];
  fs.writeFile(logFilePath, JSON.stringify(mqttMessages, null, 2), (err) => {
    if (err) {
      console.error('[MQTT] Failed to clear messages file:', err);
      return fail(res, {
        action: 'delete',
        resource: 'mqtt.messages',
        code: 'MQTT_MESSAGES_CLEAR_ERR',
        message: 'Failed to clear messages file',
        status: 500,
        legacy: { success: false },
      });
    }
    console.log('[MQTT] Message log cleared');
    return ok(res, {
      action: 'delete',
      resource: 'mqtt.messages',
      code: 'MQTT_MESSAGES_CLEAR_OK',
      message: 'Messages cleared',
      data: { cleared: true },
      legacy: { success: true },
    });
  });
});

// -------------------------------------------------------
// Reporting via email (kept as-is functionally)
// -------------------------------------------------------
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});

app.post('/report/history', async (req, res) => {
  try {
    const { to, items } = req.body;
    if (!to || !Array.isArray(items)) {
      return fail(res, {
        action: 'create',
        resource: 'report.history',
        code: 'REPORT_HISTORY_BAD_REQUEST',
        message: 'Invalid payload: { to, items[] } required',
        status: 400,
      });
    }

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

    return ok(res, {
      action: 'create',
      resource: 'report.history',
      code: 'REPORT_HISTORY_OK',
      message: 'Report sent',
      data: { sent: true, to },
      legacy: { success: true },
    });
  } catch (err) {
    console.error('[REPORT] Failed to send history email:', err);
    return fail(res, {
      action: 'create',
      resource: 'report.history',
      code: 'REPORT_HISTORY_ERR',
      message: 'Failed to send history report email',
      status: 500,
      error: err,
      legacy: { success: false },
    });
  }
});

// -------------------------------------------------------
// Auth (kept as-is functionally, wrapped responses)
// -------------------------------------------------------
let verificationCodes = {};
let passwordResetCodes = {};

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

app.post('/send-code', async (req, res) => {
  const { email } = req.body || {};
  if (!email) {
    return fail(res, {
      action: 'create',
      resource: 'auth.emailVerification',
      code: 'AUTH_SEND_CODE_BAD_REQUEST',
      message: 'Email is required',
      status: 400,
    });
  }

  try {
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return fail(res, {
        action: 'create',
        resource: 'auth.emailVerification',
        code: 'AUTH_SEND_CODE_ALREADY_REGISTERED',
        message: 'This email is already registered',
        status: 400,
      });
    }
  } catch {
    return fail(res, {
      action: 'create',
      resource: 'auth.emailVerification',
      code: 'AUTH_SEND_CODE_CHECK_ERR',
      message: 'Failed to check user existence',
      status: 500,
    });
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

    return ok(res, {
      action: 'create',
      resource: 'auth.emailVerification',
      code: 'AUTH_SEND_CODE_OK',
      message: 'Verification code sent',
      data: { email },
      legacy: { success: true },
    });
  } catch (err) {
    return fail(res, {
      action: 'create',
      resource: 'auth.emailVerification',
      code: 'AUTH_SEND_CODE_ERR',
      message: 'Failed to send verification code',
      status: 500,
      error: err,
    });
  }
});

app.post('/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  if (!email) {
    return fail(res, {
      action: 'create',
      resource: 'auth.passwordReset',
      code: 'AUTH_FORGOT_BAD_REQUEST',
      message: 'Email is required',
      status: 400,
    });
  }

  try {
    const user = await User.findOne({ email });
    if (!user) {
      return fail(res, {
        action: 'create',
        resource: 'auth.passwordReset',
        code: 'AUTH_FORGOT_NOT_FOUND',
        message: 'This email is not registered',
        status: 404,
      });
    }

    const code = generateCode();
    passwordResetCodes[email] = code;

    await transporter.sendMail({
      from: `Smart Soap Dispenser <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Password Reset Code',
      text: `Your password reset code is: ${code}`,
    });

    return ok(res, {
      action: 'create',
      resource: 'auth.passwordReset',
      code: 'AUTH_FORGOT_OK',
      message: 'Password reset code sent',
      data: { email },
      legacy: { success: true },
    });
  } catch (err) {
    return fail(res, {
      action: 'create',
      resource: 'auth.passwordReset',
      code: 'AUTH_FORGOT_ERR',
      message: 'Failed to send password reset code',
      status: 500,
      error: err,
    });
  }
});

app.post('/verify-reset-code', async (req, res) => {
  const { email, code } = req.body || {};
  if (!email || !code) {
    return fail(res, {
      action: 'verify',
      resource: 'auth.passwordReset',
      code: 'AUTH_VERIFY_BAD_REQUEST',
      message: 'Email and code are required',
      status: 400,
    });
  }

  try {
    const user = await User.findOne({ email });
    if (!user) {
      return fail(res, {
        action: 'verify',
        resource: 'auth.passwordReset',
        code: 'AUTH_VERIFY_NOT_FOUND',
        message: 'This email is not registered',
        status: 404,
      });
    }

    const expected = passwordResetCodes[email];
    if (!expected) {
      return fail(res, {
        action: 'verify',
        resource: 'auth.passwordReset',
        code: 'AUTH_VERIFY_NO_CODE',
        message: 'No reset code found or it has expired',
        status: 400,
      });
    }

    if (expected !== code) {
      return fail(res, {
        action: 'verify',
        resource: 'auth.passwordReset',
        code: 'AUTH_VERIFY_INVALID_CODE',
        message: 'Invalid reset code',
        status: 400,
      });
    }

    delete passwordResetCodes[email];
    return ok(res, {
      action: 'verify',
      resource: 'auth.passwordReset',
      code: 'AUTH_VERIFY_OK',
      message: 'Code verified',
      data: { email },
      legacy: { success: true },
    });
  } catch (err) {
    return fail(res, {
      action: 'verify',
      resource: 'auth.passwordReset',
      code: 'AUTH_VERIFY_ERR',
      message: 'Internal server error',
      status: 500,
      error: err,
    });
  }
});

app.post('/register', async (req, res) => {
  const { email, password } = req.body || {};
  try {
    if (!email || !password) {
      return fail(res, {
        action: 'create',
        resource: 'auth.register',
        code: 'AUTH_REGISTER_BAD_REQUEST',
        message: 'Email and password are required',
        status: 400,
      });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return fail(res, {
        action: 'create',
        resource: 'auth.register',
        code: 'AUTH_REGISTER_EXISTS',
        message: 'Email already registered',
        status: 400,
      });
    }

    const hashed = await bcrypt.hash(password, 10);
    await new User({ email, password: hashed }).save();

    return ok(res, {
      action: 'create',
      resource: 'auth.register',
      code: 'AUTH_REGISTER_OK',
      message: 'User registered',
      data: { email },
      legacy: { success: true },
    });
  } catch (err) {
    return fail(res, {
      action: 'create',
      resource: 'auth.register',
      code: 'AUTH_REGISTER_ERR',
      message: 'Registration failed',
      status: 500,
      error: err,
    });
  }
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  try {
    const user = await User.findOne({ email });
    if (!user) {
      return fail(res, {
        action: 'create',
        resource: 'auth.login',
        code: 'AUTH_LOGIN_INVALID',
        message: 'Invalid email or password',
        status: 400,
      });
    }

    const okPw = await bcrypt.compare(password, user.password);
    if (!okPw) {
      return fail(res, {
        action: 'create',
        resource: 'auth.login',
        code: 'AUTH_LOGIN_INVALID',
        message: 'Invalid email or password',
        status: 400,
      });
    }

    return ok(res, {
      action: 'create',
      resource: 'auth.login',
      code: 'AUTH_LOGIN_OK',
      message: 'Login successful',
      data: { email },
      legacy: { success: true },
    });
  } catch (err) {
    return fail(res, {
      action: 'create',
      resource: 'auth.login',
      code: 'AUTH_LOGIN_ERR',
      message: 'Login failed',
      status: 500,
      error: err,
    });
  }
});

app.post('/reset-password', async (req, res) => {
  const { email, newPassword } = req.body || {};
  if (!email || !newPassword) {
    return fail(res, {
      action: 'update',
      resource: 'auth.password',
      code: 'AUTH_RESET_BAD_REQUEST',
      message: 'Email and new password are required',
      status: 400,
    });
  }

  try {
    const user = await User.findOne({ email });
    if (!user) {
      return fail(res, {
        action: 'update',
        resource: 'auth.password',
        code: 'AUTH_RESET_NOT_FOUND',
        message: 'This email is not registered',
        status: 404,
      });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    return ok(res, {
      action: 'update',
      resource: 'auth.password',
      code: 'AUTH_RESET_OK',
      message: 'Password reset',
      data: { email },
      legacy: { success: true },
    });
  } catch (err) {
    return fail(res, {
      action: 'update',
      resource: 'auth.password',
      code: 'AUTH_RESET_ERR',
      message: 'Internal server error',
      status: 500,
      error: err,
    });
  }
});

// -------------------------------------------------------
// RFID Enroll API
// -------------------------------------------------------

/**
 * Create a new pending enroll request.
 * Body: { fullName: string, deviceId: string, ttlHours?: number }
 */
app.post('/api/v1/enroll/requests', async (req, res) => {
  try {
    const { fullName, deviceId, ttlHours } = req.body || {};
    if (!fullName || !deviceId) {
      return fail(res, {
        action: 'create',
        resource: 'enroll.request',
        code: 'ENROLL_REQUEST_CREATE_BAD_REQUEST',
        message: 'fullName and deviceId are required',
        status: 400,
        legacy: { success: false },
      });
    }

    const now = new Date();
    const ttl = Math.max(1, Math.min(24, Number(ttlHours) || 6));
    const expiresAt = new Date(now.getTime() + ttl * 60 * 60 * 1000);

    // Cancel any previous pendings for same device (keep queue clean)
    await EnrollRequest.updateMany({ deviceId, status: 'pending' }, { $set: { status: 'cancelled' } });

    const doc = await EnrollRequest.create({
      deviceId,
      fullName,
      requestedAt: now,
      expiresAt,
      status: 'pending',
    });

    console.log(`[ENROLL] Pending created device=${deviceId} name="${fullName}" id=${doc._id.toString()}`);

    return ok(res, {
      action: 'create',
      resource: 'enroll.request',
      code: 'ENROLL_REQUEST_CREATE_OK',
      message: 'Enroll request created',
      data: {
        requestId: doc._id.toString(),
        deviceId,
        fullName,
        expiresAt,
      },
      // legacy for current app
      legacy: {
        success: true,
      },
    });
  } catch (err) {
    console.error('[ENROLL] Create error:', err);
    return fail(res, {
      action: 'create',
      resource: 'enroll.request',
      code: 'ENROLL_REQUEST_CREATE_ERR',
      message: 'Failed to create enroll request',
      status: 500,
      error: err,
      legacy: { success: false },
    });
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
    if (!deviceId) {
      return fail(res, {
        action: 'fetch',
        resource: 'enroll.request',
        code: 'ENROLL_REQUEST_FETCH_BAD_REQUEST',
        message: 'deviceId is required',
        status: 400,
        legacy: { success: false },
      });
    }

    const doc = await EnrollRequest.findOne({
      deviceId,
      status: 'pending',
      expiresAt: { $gt: new Date() },
    })
      .sort({ createdAt: -1 })
      .lean();

    if (!doc) {
      return ok(res, {
        action: 'fetch',
        resource: 'enroll.request',
        code: 'ENROLL_REQUEST_FETCH_EMPTY',
        message: 'No pending request',
        data: { request: null },
        legacy: { success: true, request: null },
      });
    }

    console.log(`[ENROLL] Device poll device=${deviceId} → pending id=${doc._id}`);

    return ok(res, {
      action: 'fetch',
      resource: 'enroll.request',
      code: 'ENROLL_REQUEST_FETCH_OK',
      message: 'Pending request found',
      data: {
        request: {
          id: String(doc._id),
          deviceId: doc.deviceId,
          fullName: doc.fullName,
          requestedAt: doc.requestedAt,
          expiresAt: doc.expiresAt,
          status: doc.status,
        },
      },
      // legacy for current app/powershell snippet
      legacy: {
        success: true,
        request: {
          id: String(doc._id),
          fullName: doc.fullName,
          requestedAt: doc.requestedAt,
          expiresAt: doc.expiresAt,
        },
      },
    });
  } catch (err) {
    console.error('[ENROLL] Poll error:', err);
    return fail(res, {
      action: 'fetch',
      resource: 'enroll.request',
      code: 'ENROLL_REQUEST_FETCH_ERR',
      message: 'Failed to fetch enroll request',
      status: 500,
      error: err,
      legacy: { success: false },
    });
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
      return fail(res, {
        action: 'complete',
        resource: 'enroll.complete',
        code: 'ENROLL_COMPLETE_BAD_REQUEST',
        message: 'deviceId, requestId and uid are required',
        status: 400,
        legacy: { success: false },
      });
    }

    const normalizedUid = String(uid).replace(/\s+/g, '').toUpperCase();
    if (!/^[0-9A-F]+$/.test(normalizedUid) || normalizedUid.length < 8) {
      return fail(res, {
        action: 'complete',
        resource: 'enroll.complete',
        code: 'ENROLL_COMPLETE_BAD_UID',
        message: 'Invalid uid format',
        status: 400,
        legacy: { success: false },
      });
    }

    const reqDoc = await EnrollRequest.findOne({ _id: requestId, deviceId });
    if (!reqDoc) {
      return fail(res, {
        action: 'complete',
        resource: 'enroll.complete',
        code: 'ENROLL_COMPLETE_NOT_FOUND',
        message: 'Enroll request not found',
        status: 404,
        legacy: { success: false },
      });
    }
    if (reqDoc.status !== 'pending') {
      return fail(res, {
        action: 'complete',
        resource: 'enroll.complete',
        code: 'ENROLL_COMPLETE_NOT_PENDING',
        message: 'Enroll request is not pending',
        status: 400,
        legacy: { success: false },
      });
    }
    if (reqDoc.expiresAt <= new Date()) {
      return fail(res, {
        action: 'complete',
        resource: 'enroll.complete',
        code: 'ENROLL_COMPLETE_EXPIRED',
        message: 'Enroll request expired',
        status: 400,
        legacy: { success: false },
      });
    }

    const card = await AuthorizedCard.findOneAndUpdate(
      { deviceId, uid: normalizedUid },
      { deviceId, uid: normalizedUid, ownerName: reqDoc.fullName, revokedAt: null },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    reqDoc.status = 'completed';
    reqDoc.completedAt = new Date();
    await reqDoc.save();

    console.log(`[ENROLL] Completed device=${deviceId} uid=${normalizedUid} owner="${reqDoc.fullName}" cardId=${card._id}`);

    return ok(res, {
      action: 'complete',
      resource: 'enroll.complete',
      code: 'ENROLL_COMPLETE_OK',
      message: 'Enroll completed',
      data: { cardId: String(card._id), uid: normalizedUid, ownerName: reqDoc.fullName },
      legacy: { success: true },
    });
  } catch (err) {
    console.error('[ENROLL] Complete error:', err);
    return fail(res, {
      action: 'complete',
      resource: 'enroll.complete',
      code: 'ENROLL_COMPLETE_ERR',
      message: 'Failed to complete enroll',
      status: 500,
      error: err,
      legacy: { success: false },
    });
  }
});

/**
 * List authorized cards per device (for UI).
 * GET /api/v1/cards?deviceId=XYZ
 */
app.get('/api/v1/cards', async (req, res) => {
  try {
    const deviceId = String(req.query.deviceId || '');
    if (!deviceId) {
      return fail(res, {
        action: 'list',
        resource: 'cards',
        code: 'CARDS_LIST_BAD_REQUEST',
        message: 'deviceId is required',
        status: 400,
        legacy: { success: false },
      });
    }

    const rows = await AuthorizedCard.find({ deviceId, revokedAt: null }).sort({ createdAt: -1 }).lean();

    return ok(res, {
      action: 'list',
      resource: 'cards',
      code: 'CARDS_LIST_OK',
      message: 'Cards fetched',
      data: { items: rows },
      // legacy support
      legacy: { success: true, items: rows },
    });
  } catch (err) {
    console.error('[CARDS] List error:', err);
    return fail(res, {
      action: 'list',
      resource: 'cards',
      code: 'CARDS_LIST_ERR',
      message: 'Failed to list cards',
      status: 500,
      error: err,
      legacy: { success: false },
    });
  }
});

/**
 * Revoke a card.
 * POST /api/v1/cards/revoke  { deviceId, uid }
 */
app.post('/api/v1/cards/revoke', async (req, res) => {
  try {
    const { deviceId, uid } = req.body || {};
    if (!deviceId || !uid) {
      return fail(res, {
        action: 'update',
        resource: 'cards',
        code: 'CARDS_REVOKE_BAD_REQUEST',
        message: 'deviceId and uid are required',
        status: 400,
        legacy: { success: false },
      });
    }

    const normalizedUid = String(uid).replace(/\s+/g, '').toUpperCase();
    const card = await AuthorizedCard.findOne({ deviceId, uid: normalizedUid });
    if (!card) {
      return fail(res, {
        action: 'update',
        resource: 'cards',
        code: 'CARDS_REVOKE_NOT_FOUND',
        message: 'Card not found',
        status: 404,
        legacy: { success: false },
      });
    }
    if (card.revokedAt) {
      return ok(res, {
        action: 'update',
        resource: 'cards',
        code: 'CARDS_REVOKE_ALREADY',
        message: 'Card already revoked',
        data: { alreadyRevoked: true },
        legacy: { success: true },
      });
    }

    card.revokedAt = new Date();
    await card.save();

    console.log(`[CARDS] Revoked device=${deviceId} uid=${normalizedUid}`);

    return ok(res, {
      action: 'update',
      resource: 'cards',
      code: 'CARDS_REVOKE_OK',
      message: 'Card revoked',
      data: { uid: normalizedUid },
      legacy: { success: true },
    });
  } catch (err) {
    console.error('[CARDS] Revoke error:', err);
    return fail(res, {
      action: 'update',
      resource: 'cards',
      code: 'CARDS_REVOKE_ERR',
      message: 'Failed to revoke card',
      status: 500,
      error: err,
      legacy: { success: false },
    });
  }
});

// -------------------------------------------------------
// HTTP Server
// -------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[BOOT] HTTP server listening on ${PORT}`);
});

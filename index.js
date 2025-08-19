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

/* === MongoDB Connection === */
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connection established.'))
  .catch((err) => console.error('MongoDB connection error:', err));

/* === User Model === */
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
});
const User = mongoose.model('User', userSchema);

/* === MQTT Logging === */
const logFilePath = 'mqtt_log.json';
let mqttMessages = [];

if (fs.existsSync(logFilePath)) {
  try {
    const data = fs.readFileSync(logFilePath, 'utf8');
    mqttMessages = JSON.parse(data);
    console.log(`Loaded ${mqttMessages.length} messages from log.`);
  } catch (err) {
    console.error('Failed to read MQTT log file:', err);
  }
}

const brokerUrl = 'ws://52.29.86.137:8000/mqtt';
const client = mqtt.connect(brokerUrl);

client.on('connect', () => {
  console.log('Connected to MQTT broker.');
  client.subscribe('stm32/demo', (err) => {
    if (err) console.error('MQTT subscribe error:', err);
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
    if (err) {
      console.error('Failed to save MQTT message to file:', err);
    } else {
      console.log('MQTT message appended to file.');
    }
  });
});

app.get('/api/messages', (req, res) => {
  res.json(mqttMessages);
});

/* === Clear All MQTT Messages === */
app.delete('/api/messages', (req, res) => {
  mqttMessages = [];
  fs.writeFile(logFilePath, JSON.stringify(mqttMessages, null, 2), (err) => {
    if (err) {
      console.error('Failed to clear MQTT log file:', err);
      return res.status(500).json({ success: false, error: 'Failed to clear messages file.' });
    }
    console.log('MQTT messages cleared.');
    return res.json({ success: true });
  });
});
/* === Send device history report via email === */
app.post('/report/history', async (req, res) => {
  try {
    const { to, items } = req.body;
    if (!to || !Array.isArray(items)) {
      return res.status(400).json({ success: false, error: 'Invalid payload: { to, items[] } required.' });
    }

    // Build a clean HTML report (table)
    const rows = items.map((it, idx) => `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${idx + 1}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${it.person || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${it.level || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${it.fillTime || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${it.levelTime || '-'}</td>
      </tr>
    `).join('');

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
    console.error('Failed to send history report email:', err);
    return res.status(500).json({ success: false, error: 'Failed to send history report email.' });
  }
});

/* === Email Verification & Password Reset (in-memory codes) === */
let verificationCodes = {};
let passwordResetCodes = {};

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/* === Send Email Verification Code (for registration) === */
app.post('/send-code', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  try {
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'This email is already registered.' });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to check user existence.' });
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

    console.log(`Registration verification code sent to ${email}: ${code}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to send registration verification code:', err);
    res.status(500).json({ error: 'Failed to send verification code.' });
  }
});

/* === Send Password Reset Code (single endpoint) === */
app.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: 'This email is not registered.' });
    }

    const code = generateCode();
    passwordResetCodes[email] = code;

    await transporter.sendMail({
      from: `Smart Soap Dispenser <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Password Reset Code',
      text: `Your password reset code is: ${code}`,
    });

    console.log(`Password reset code sent to ${email}: ${code}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to send password reset code:', err);
    res.status(500).json({ error: 'Failed to send password reset code.' });
  }
});

/* === Verify Password Reset Code === */
app.post('/verify-reset-code', async (req, res) => {
  const { email, code } = req.body;

  if (!email || !code) {
    return res.status(400).json({ error: 'Email and code are required.' });
  }

  try {
    const user = await User.findOne({ email });
    if (!user) {
      console.log(`Reset code verification failed: Email not found - ${email}`);
      return res.status(404).json({ error: 'This email is not registered.' });
    }

    const expectedCode = passwordResetCodes[email];
    if (!expectedCode) {
      console.log(`No reset code found for: ${email}`);
      return res.status(400).json({ error: 'No reset code found or it has expired.' });
    }

    if (expectedCode !== code) {
      console.log(`Invalid reset code for: ${email}`);
      return res.status(400).json({ error: 'Invalid reset code.' });
    }

    delete passwordResetCodes[email];
    console.log(`Reset code verified for: ${email}`);
    return res.json({ success: true });
  } catch (err) {
    console.error(`Error verifying reset code for ${email}:`, err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

/* === Register User === */
app.post('/register', async (req, res) => {
  const { email, password } = req.body;

  try {
    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ error: 'Email already registered.' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ email, password: hashedPassword });

    await newUser.save();
    console.log(`New user registered: ${email}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Registration failed.' });
  }
});

/* === Login User === */
app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: 'Invalid email or password.' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: 'Invalid email or password.' });

    console.log(`Login successful: ${email}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed.' });
  }
});

/* === Set New Password === */
app.post('/reset-password', async (req, res) => {
  const { email, newPassword } = req.body;

  if (!email || !newPassword) {
    return res.status(400).json({ error: 'Email and new password are required.' });
  }

  try {
    const user = await User.findOne({ email });
    if (!user) {
      console.log(`Password reset failed: Email not found - ${email}`);
      return res.status(404).json({ error: 'This email is not registered.' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    await user.save();

    console.log(`Password reset for: ${email}`);
    return res.json({ success: true });
  } catch (err) {
    console.error(`Error resetting password for ${email}:`, err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

/* === Start HTTP Server === */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

# Smart Soap Dispenser Server

This Node.js server handles MQTT logging, email verification, and user authentication for an IoT-based smart liquid dispenser system.

## Features

- MQTT over WebSocket connection (logs messages to a file)
- MongoDB-based user registration and login with hashed passwords
- Nodemailer integration for:
  - Email verification
  - Password reset
  - Device history report emails
- REST API endpoints for mobile app integration

## API Endpoints

| Method | Endpoint              | Description                          |
|--------|------------------------|--------------------------------------|
| GET    | `/api/messages`       | Get all received MQTT messages       |
| DELETE | `/api/messages`       | Clear all MQTT messages              |
| POST   | `/report/history`     | Send device history via email        |
| POST   | `/send-code`          | Send email verification code         |
| POST   | `/forgot-password`    | Send password reset code             |
| POST   | `/verify-reset-code`  | Verify password reset code           |
| POST   | `/register`           | Register a new user                  |
| POST   | `/login`              | Login with email and password        |
| POST   | `/reset-password`     | Set new password after verification  |

## Environment Variables

Create a `.env` file based on `.env.example`:


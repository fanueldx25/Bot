# Fanuel WhatsApp Bot & Control Dashboard

An advanced, production-ready multi-device WhatsApp bot powered by `@whiskeysockets/baileys`, featuring a secure web admin control panel, PostgreSQL session & state storage, media downloaders (YouTube, TikTok, Instagram, Spotify), AI integration, anti-link protection, auto-status reaction, and view-once captor.

---

## 🌟 Key Features

- **Multi-Device WhatsApp Pairing**: Connect via QR Code or 8-digit Pairing Code. Persistent auth stored securely in PostgreSQL.
- **Secure Admin Dashboard**: Full-screen master passkey authentication gate protecting all management actions and settings.
- **Advanced Media Scavenger**: High-definition YouTube (`yta`, `ytv`, `play`), TikTok (no watermark / slideshows), Instagram, and Spotify downloader with automated FFmpeg MP3 transcoding.
- **AI & Automation**: Gemini AI integration, auto-status liker/reactor, anti-link moderation, and view-once media captor.
- **Self-Ping Keep-Alive**: Built-in keep-alive cron ping to prevent free-tier hosting shutdowns (Render / Cloud Run).

---

## 🚀 Environment Variables (`.env`)

Copy `.env.example` to `.env` and configure the following variables:

| Variable | Description | Example |
| :--- | :--- | :--- |
| `GEMINI_API_KEY` | Google Gemini AI API key | `AIzaSy...` |
| `APP_URL` | Public URL of your deployed app | `https://your-bot.onrender.com` |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@host:5432/dbname?sslmode=require` |
| `DASHBOARD_PASSWORD` | Master passkey for dashboard security | `SuperSecretPass123` |
| `PORT` | Server listening port (default: 3000) | `3000` |

---

## 🐘 Setting Up PostgreSQL Database

1. Create a PostgreSQL database instance on **Render**, **Supabase**, **Neon**, or AWS RDS.
2. Ensure you have the External Connection URL (`DATABASE_URL`).
3. Run database migrations and push schema:
   ```bash
   npm run db:push
   ```

---

## 🚢 Deployment Guide for Render

This repository includes a `render.yaml` blueprint for instant one-click deployment on Render.

### Method 1: Blueprint Deployment (Recommended)
1. Push your repository to GitHub.
2. Log in to [Render Dashboard](https://dashboard.render.com/).
3. Click **New** -> **Blueprint**.
4. Connect your GitHub repository. Render will automatically read `render.yaml` and configure the web service.
5. Add your environment variables (`DATABASE_URL`, `DASHBOARD_PASSWORD`, `GEMINI_API_KEY`, etc.) in the Render dashboard settings.
6. Click **Apply**.

### Method 2: Manual Web Service Setup
1. Create a **New Web Service** on Render connected to your repository.
2. Configure settings:
   - **Environment**: `Node`
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`
3. Add Environment Variables under the **Environment** tab:
   - `NODE_ENV` = `production`
   - `DATABASE_URL` = Your PostgreSQL connection string
   - `DASHBOARD_PASSWORD` = Your secure master passkey
   - `APP_URL` = Your Render web service URL (`https://<your-service>.onrender.com`)
4. Deploy!

---

## 🔒 Security & Usage

- **Admin Access**: When opening your deployed URL, visitors are greeted with a secure full-screen login gate. Enter your `DASHBOARD_PASSWORD` to unlock the control panel.
- **Keep-Alive**: The server automatically pings its `/ping` endpoint every 4 minutes to prevent Render free instances from spinning down due to inactivity.

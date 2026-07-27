# 🎯 TalentFlow ATS

A professional, cloud-powered **Applicant Tracking System** built with vanilla HTML/CSS/JS and Firebase (Firestore + Auth).

[![Live Demo](https://img.shields.io/badge/Live%20Demo-GitHub%20Pages-4f46e5?style=for-the-badge)](https://bswood7.github.io/mini-ats/)

---

## ✨ Features

- **🔐 Secure Auth** — Email/password sign-up and sign-in via Firebase Authentication
- **👥 Candidate Management** — Add, edit, view, and delete candidates with full profile details
- **📊 Dashboard** — Real-time pipeline overview with stats, bar charts, and recent candidates
- **🔍 Search & Filter** — Filter by status, department, sort by name/date
- **📋 Pipeline Tracking** — Selected / Rejected / On Hold statuses with visual badges
- **💼 Work History** — Track multiple work experiences per candidate
- **🏢 Departments** — Department cards with pipeline breakdown per team
- **📱 Responsive** — Works on desktop and mobile
- **☁️ Cloud Storage** — Firebase Firestore stores **unlimited candidates** (500+ with ease)
- **⚡ Pagination** — 50 candidates per page, supporting large data sets

## 🚀 Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | HTML5, CSS3, Vanilla JS (ES Modules) |
| Auth | Firebase Authentication v10 |
| Database | Firebase Firestore (NoSQL, real-time) |
| Hosting | GitHub Pages |

## 📦 Storage Capacity

Firestore supports **unlimited documents** per collection. The app is architected with per-user collections (`users/{uid}/candidates`), so each user can store well beyond **500 candidates** with no code changes needed.

## 🛠️ Local Development

```bash
# Clone the repository
git clone https://github.com/bswood7/mini-ats.git
cd mini-ats

# Serve locally (any static server)
npx serve .
# or
python3 -m http.server 3000
```

Then open `http://localhost:3000` in your browser.

## 🔧 Firebase Setup

1. Create a project at [Firebase Console](https://console.firebase.google.com)
2. Enable **Email/Password** under Authentication → Sign-in methods
3. Create a **Firestore Database** (start in test mode for development)
4. Copy your config into `app.js` → `firebaseConfig`

## 🌐 Deploying to GitHub Pages

```bash
git add .
git commit -m "Initial deployment"
git push origin main
```

Then go to **Settings → Pages → Branch: main → / (root)** and save.

---

Made with ❤️ by [bswood7](https://github.com/bswood7)

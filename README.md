# resqpk-backend

Node.js + Express + Socket.io backend for **ResQPK** — a smart emergency-response system (Final Year Project).

## Stack
- Node.js (ES Modules) + Express 5
- Supabase (PostgreSQL, Auth, Storage)
- Socket.io (real-time)
- JWT authentication

## Setup
1. `npm install`
2. Copy `.env.example` to `.env` and fill in your values
3. `npm run dev` (development, auto-reload) or `npm start`
4. Health check: `GET http://localhost:3000/health`

## Scripts
- `npm run dev` — start with nodemon (auto-reload)
- `npm start` — start with node
- `npm test` — placeholder

## Environment
All configuration comes from `.env` (see `.env.example` for the template).
`.env` is git-ignored and must never be committed.

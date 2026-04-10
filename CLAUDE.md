# PSM Commissions

Affiliate commission tracking and management system. Calculates, tracks, and reports weekly payouts to gaming affiliates based on tier-based commission rates.

## Quick Start

```bash
npm install
npm start              # Start server (port 3000 or PORT env var)
```

## Tech Stack

- **Backend:** Node.js + Express
- **Database:** SQLite (better-sqlite3, WAL mode)
- **Frontend:** EJS templating
- **Integrations:** Telegram Bot API, PDFKit for report generation
- **Deploy:** Railway

## Project Structure

```
server.js               # Express app entry point
views/                  # EJS templates
public/                 # Static assets
```

## Key Concepts

- **Tier System:** Commission rates 0.20-0.40 based on average players and USD sold
- **Carryover:** Negative net balances carry forward to next week's payout
- **Flexible Expenses:** Dynamic extra expense entries (marketing costs, etc.) stored as JSON
- **Status Tracking:** Reports default to `pending` (displayed as "Pending Review"), toggle to `paid`. Legacy `unpaid` rows are still treated as "Pending Review" in the UI. PDFs only stamp a status when `paid`.
- **Timezone:** Fixed to America/Chicago

## Routes

- `GET /` — Dashboard (segmented by tier: top/mid/misc affiliates)
- `POST/GET /affiliate/:id` — View/edit affiliate; Telegram verification
- `GET/POST /report/new` — Create weekly report with auto-preload
- `GET/POST /report/:id/edit` — Edit existing report
- `POST /api/calculate` — Live preview commission calculations
- `POST /report/:id/telegram` — Send report via Telegram
- `GET /report/:id/pdf` — Download PDF report
- `POST /report/:id/status` — Update payout status

## Database Schema

- `affiliates` — Profiles with optional rate overrides
- `weekly_reports` — Complete report data including calculated values, expenses, carryover
- `player_weekly` — Historical player count tracking per affiliate per week

## Environment

`PORT` (default 3000), `TELEGRAM_BOT_TOKEN` for Telegram integration.

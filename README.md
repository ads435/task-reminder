# Renewal Tracker

Task manager + SSL/TLS certificate renewal tracker that **emails you reminders**.

## Run
```bash
npm install
cp .env.example .env   # fill in SMTP details
npm start              # http://localhost:3000
```

## How reminders work
- A scheduler checks every 15 minutes (only after the configured send hour).
- Certificates: emailed once at each threshold (default 90/60/30/14/7/3/1 days before expiry), then **daily once expired**.
- Tasks: emailed at the configured days before due (default 1 day and the due date), then daily while overdue. Completed tasks are skipped.
- Reminders are sent as one digest email. Recipients = global recipients (Settings) + the item's owner email.
- "Mark renewed" sets the new expiry and restarts the reminder cycle.
- The Notifications tab is the log of every email sent (or dry-run / failed).

## Email setup
Set `SMTP_*` in `.env`. Without `SMTP_HOST` the app runs in dry-run mode (logs only). Use the **Send test email** button in Settings to verify.

## Notes
- Data lives in `data.json` (back it up). Keep the app running (pm2, systemd, Docker, or a small VPS) so the scheduler can fire.
- Set `APP_PASSWORD` if the app is reachable from outside your network.
- "Fetch expiry from live domain" reads the certificate of a public host on port 443.

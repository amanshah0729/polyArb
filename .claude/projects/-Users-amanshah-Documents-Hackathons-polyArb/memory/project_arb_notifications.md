---
name: BFA Arb Email Notifications
description: Building automated email notifications for BFA↔Polymarket arbitrage opportunities, deploying on Render
type: project
---

Building an automated arb notification system for BFA sportsbook vs Polymarket.

**Key decisions:**
- Email via Resend
- Scan interval: ~5 min with jitter (4-8 min random variance)
- Threshold: cost ≤ 1.000 (true arb only, may loosen later)
- Deploy on Render (free tier) with UptimeRobot or similar to keep it alive
- Email content: essentials only (game, strategy, cost, bet sizes, profit)
- Deduplication needed so same arb doesn't spam emails
- Starting with BFA only, may add other books later

**Why:** User wants to be notified of arb opportunities in real-time rather than manually clicking refresh on the dashboard.

**How to apply:** When implementing, extract the core arb logic from getBFAGamingArb.js into a reusable module, add Resend email sending, wrap in a jittered interval loop, and make it deployable as a standalone Node service on Render.

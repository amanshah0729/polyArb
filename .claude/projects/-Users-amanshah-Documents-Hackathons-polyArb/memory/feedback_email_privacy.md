---
name: Email privacy
description: User's notification email must never be hardcoded or committed - always read from env vars
type: feedback
---

Never hardcode or commit the user's email address. Always read from NOTIFICATION_EMAIL env var.

**Why:** User explicitly asked that their email not be leaked anywhere.

**How to apply:** Any code that sends notifications must pull the recipient from process.env.NOTIFICATION_EMAIL. Never write the actual address into source files, configs, or logs.

# Outreach Command Centre: setup and operations

Admin dashboard > **Outreach** tab. Everything runs on demand from that page (no background worker).

## 1. One-time setup

1. **Database.** Run `migrations/2026_12_RUN_ALL_OUTREACH.sql` once in the Supabase SQL editor
   (the `2026_11_gx_*` scripts must already have been run). It is safe to re-run.
2. **Deploy** the backend and frontend (feature branch `outreach-command-centre` in both repos, merge to master/main when approved).
3. **Open Outreach > Permissions & Limits** and review the limits. Leave "legitimate-interest B2B email" OFF until the
   Legitimate Interest Assessment has been completed and you have recorded that in the page.

## 2. Environment variables (Render, backend)

| Variable | Needed for | Notes |
|---|---|---|
| `RESEND_API_KEY` | sending email | already set for platform emails |
| `OUTREACH_FROM_EMAIL` | sending email | an address on a domain verified in Resend, ideally a separate sending subdomain (e.g. `outreach@mail.trygethome.online`). Falls back to `SMTP_FROM`. |
| `RESEND_WEBHOOK_SECRET` | delivery, bounce, complaint tracking | Resend dashboard > Webhooks > signing secret (`whsec_...`). Endpoint: `POST /api/growth/webhooks/resend`. Without it the endpoint refuses all calls. |
| `API_PUBLIC_URL` | unsubscribe links | your Render URL, e.g. `https://gethome-backend-7ocr.onrender.com`. Falls back to `RENDER_EXTERNAL_URL`. |
| `GROWTH_SIGNING_SECRET` | unsubscribe links | any long random string. If unset, one is derived from the Supabase key. Do not change it once emails are out. |
| `ANTHROPIC_API_KEY` | AI personalisation (optional) | already set for the AI chat. Optional `OUTREACH_AI_MODEL`. |
| `LOCAL_AI_URL`, `LOCAL_AI_MODEL`, `LOCAL_AI_KEY` | local/hosted model (optional) | any `/chat/completions`-compatible server |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_PORT` | SMTP instead of Resend (optional) | then set the email provider to SMTP in the page |
| `OUTREACH_SEARCH_MODEL` | web search discovery (optional) | model used with `ANTHROPIC_API_KEY`; defaults to `claude-opus-5-5`. A cheaper model such as `claude-haiku-4-5` costs less. |
| `OVERPASS_URL`, `OSM_USER_AGENT` | OpenStreetMap discovery (optional) | defaults to the public Overpass server |
| `WA_PHONE_NUMBER_ID`, `WA_ACCESS_TOKEN` | sending WhatsApp | Meta Business > WhatsApp > API setup |
| `WA_BUSINESS_ACCOUNT_ID` | WhatsApp templates | WhatsApp Business Account ID |
| `WA_APP_SECRET` | WhatsApp webhook signature | Meta app > Settings > Basic > App secret |
| `WA_VERIFY_TOKEN` | WhatsApp webhook handshake | any string you choose; enter the same in Meta |
| `WA_GRAPH_VERSION` | optional | defaults to `v21.0` |

No credential is ever stored in the database or shown in the page.

## 3. Webhooks to register

* **Resend:** `https://<your-render-url>/api/growth/webhooks/resend`, events: delivered, bounced, complained (and received, if you use Resend inbound).
* **WhatsApp (Meta):** callback `https://<your-render-url>/api/growth/webhooks/whatsapp`, verify token = `WA_VERIFY_TOKEN`, subscribe to `messages`.

## 4. Daily use

1. **Discovery:** choose a state and press **Find prospects** (web search by default; OpenStreetMap or your own website list also work), or import a CSV. Review results under *Prospects*; merge duplicates under *Duplicates*.
2. **Qualify and permission:** prospects with contact details are auto-qualified. Record explicit consent (Prospects > open one > Consent record) where you have it. Use "Can we message this prospect?" to see exactly why a send is allowed or blocked.
3. **Campaign:** create a follow-up *sequence* (invitation + up to two follow-ups), create a *campaign*, **Enrol** prospects (only those passing the permission check are enrolled), **Activate**, **Prepare messages**.
4. **Review & Send:** read, edit, approve or reject each message, then **Send approved now** (or **Run cycle now** on the Campaigns tab, which also prepares due follow-ups).
   For a one-off WhatsApp to many people, use **Send > Bulk WhatsApp** instead: pick an approved template and press **Send now**.
5. **Replies:** log email replies, answer WhatsApp replies within 24 hours, mark handled.
6. **Dashboard:** press **Sync registrations & payments** to link prospects to real GetHome accounts and record verified payments, then read the figures.

## 5. Rules built in

* Email goes to anyone who can receive it and has not blocked us. Opted out, unsubscribed, complained, bounced or replied "not interested" are blocked. Previously emailed, replied and registered prospects can be emailed again. Always with an unsubscribe link. The daily email limit still applies.
* WhatsApp marketing goes to anyone with a number who has not blocked us (no recorded opt-in needed), only as Meta-approved templates. Meta's policy expects opt-in and can restrict a number that gets blocked or reported, so start with small batches and put "Reply STOP to opt out" in each template. Free-form replies only inside 24 hours of the prospect's message.
* Automatic follow-ups stop: after the attempt limit (default 2), on reply, registration, subscription, opt-out, bounce, or admin stop.
* Opt-outs and bounces go on a permanent suppression list that imports and campaigns check.
* Paying agents and revenue count only payments with a verified payment reference. The compensation model is not changed.
* Delivered is a provider event; email opens are not measured.

## 6. Roles

GetHome admins are owners. Grant narrower access (`admin`, `recruiter`, `viewer`) with `PUT /api/growth/outreach/roles/:userId` (owner only).
Viewers read; recruiters edit prospects; admins handle consent, campaigns, sending, settings and exports; owners manage roles, retention and suppression removal.

## 7. Data retention

`POST /api/growth/outreach/retention/run` (owner) deletes never-contacted, never-consented prospects older than the configured number of days. It is a dry run unless `{"dry_run": false}` is sent. The suppression list is never purged.

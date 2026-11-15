# DBS Voice Receptionist

An AI phone receptionist built on Retell AI. One agent serves every client: the number a caller dials decides which business the agent speaks for.

It can:
- answer questions from each client's business info and FAQs
- take messages and email them to the client straight away
- qualify leads (hot, warm or cold) with each client's own questions
- book appointments into the client's Google Calendar
- transfer hot leads and urgent calls to a person
- email a summary, recording link and transcript after every call

It also includes a **web dashboard** at the same address:
- **Clients** sign in to see their calls (with recordings), leads, messages and bookings, edit their business info, hours, FAQs and lead questions, and export CSVs.
- **DBS admins** see every client, add new clients, set phone numbers, diaries and pricing, see each client's minutes and invoice estimate for the month, download a usage CSV for billing, and manage logins.

No npm packages are needed. It runs on Node 20 or later.

## How it works

```
Caller ─► Retell number ─► POST /retell/inbound   (we look up the client by the dialled number
                                                    and send back their name, info, hours, rules)
             │
             ├─► POST /tools/take_message        ─► email/Slack the client
             ├─► POST /tools/qualify_lead        ─► score + notify, offer transfer if hot
             ├─► POST /tools/check_availability  ─► Google Calendar free/busy
             ├─► POST /tools/book_appointment    ─► Google Calendar event
             ├─► transfer_to_team (built into Retell) ─► client's transfer number
             └─► POST /retell/webhook (call_analyzed) ─► call summary email
```

Every request from Retell is checked against its `X-Retell-Signature` before anything runs.

## Setup (about 30 minutes)

1. **Retell account.** Sign up at retellai.com and copy your API key.
2. **Deploy this server** anywhere with HTTPS, e.g. a Hostinger VPS, Railway, Render or Fly.io. A Dockerfile is included. Point a subdomain at it, e.g. `voice.dbsgroup.io`.
3. **Configure.** Copy `.env.example` to `.env` and fill in `RETELL_API_KEY` and `PUBLIC_BASE_URL`.
4. **Email alerts.** Create a free Resend.com account, verify `dbsgroup.io`, and set `RESEND_API_KEY` and `NOTIFY_FROM`. If you'd rather use Slack, Make, Zapier or n8n, set `notify.webhook` in the client file instead.
5. **Google Calendar (optional).** In Google Cloud: create a project, enable the Calendar API, create a service account and download its JSON key. Put its email and private key in `.env`. Then share each client's calendar with that service account email, with "Make changes to events" permission. Copy the calendar ID (Calendar settings → Integrate calendar) into the client file.
6. **Create the agent:** `npm run setup-agent`. This creates the agent in Retell and saves `RETELL_AGENT_ID` to `.env`. Restart the server.
7. **Phone number.** In Retell → Phone Numbers, buy or import a number. Set its inbound agent to the new agent and its **inbound webhook URL** to `https://<your-domain>/retell/inbound`.
   - **UK numbers:** Retell sells mainly US numbers. For a +44 number, import one over SIP from a UK carrier (Twilio, Telnyx, Vonage, or your own telecom platform). Or keep your existing number and forward unanswered or all calls to the Retell number.
8. **Dashboard login.** Set `SESSION_SECRET` in `.env`, then create your admin login:
   `npm run add-user -- --email you@dbsgroup.io --password "a-long-password" --role admin`
   Open `https://<your-domain>/` and sign in. Add client logins from the Users page.
9. **Test.** Call the number. Each client's messages, leads and bookings are also logged to `data/<client>/`.

## Self-service: sign-up, numbers, calendar

Clients can sign up, pay and go live without you:

1. They open `https://<your-domain>/#/signup`, choose a plan and create an account.
2. They pay by card on Stripe Checkout.
3. Stripe tells the server. The client is switched on and given a free number from your **number pool**, already connected in Retell. You and they both get an email.
4. Their dashboard shows a getting-started checklist: describe the business, choose alerts, connect Google Calendar (one click), and forward calls to their AI number.
5. Every call's minutes are reported to Stripe, so extra minutes are billed automatically. Clients update their card or cancel through **Manage billing**. Cancelling pauses them.

Keep a few spare numbers in the pool (**Numbers** page) so new sign-ups get one instantly. If the pool is empty they still go live, and you get an email asking you to add a number.

### Phone numbers
- **Numbers page → Add a number.** If the number is already in Retell, it's pointed at your agent and inbound webhook automatically. If you set `RETELL_SIP_TERMINATION_URI` (plus username and password if your trunk uses them), tick *Import* to bring UK numbers in from your own SIP trunk in one step.
- Adding a number to a client in Settings, or using *Assign number from pool*, connects it in Retell straight away. The × on a number releases it back to the pool.

### Google Calendar connect
1. In Google Cloud Console, create an OAuth client of type *Web application* and enable the Google Calendar API.
2. Set the authorised redirect URI to `https://<your-domain>/oauth/google/callback`.
3. Put the client ID and secret in `.env`.
4. Clients click **Connect Google Calendar** in Settings. Bookings go into their main calendar. Tokens are stored encrypted, and clients can disconnect at any time.
5. Before launch, submit the OAuth consent screen for Google verification. The calendar scopes are "sensitive", and until verification is approved Google shows users a warning and limits you to 100 test users.

### Stripe
1. **Meter:** Billing → Meters → create a meter with event name `voice_minutes`, aggregation *Sum*, value key `value`.
2. **Products:** for each plan in `config/plans.json`, create two prices:
   - a **monthly fee** (recurring, e.g. £99)
   - a **minutes** price (recurring, *usage-based* on the meter, *graduated* tiers: first N units £0 (the included minutes), then the per-minute rate)
3. Put the two price IDs (`price_...`) into `stripe_price_base` and `stripe_price_minutes` for each plan. Plan names, fees and features in that file are what the sign-up page shows. Edit them freely.
4. **Webhook:** Developers → Webhooks → endpoint `https://<your-domain>/stripe/webhook` with events `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
5. Turn on the **Customer portal** (Settings → Billing → Customer portal) so clients can update cards and cancel.
6. Test the whole flow in Stripe test mode with card 4242 4242 4242 4242 before switching to live keys.

Without Stripe keys, sign-up still works: accounts wait as "not active" until you press **Activate client**.

## Adding a client

In the dashboard: **Clients & billing → Add a client**, fill in their settings and pricing, then add a login for them under **Users**. In Retell, point their number at the same agent and inbound webhook. No restart or new agent needed; changes apply from the next call.

(You can also copy `tenants/example-restaurant.json` to `tenants/<client>.json` by hand and restart.)

The sample client files use Ofcom drama numbers (+44 7700 900xxx). Replace them with real numbers, and add alert emails, before going live.

| Field | Purpose |
|---|---|
| `phone_numbers` | Numbers that route to this client, in E.164 format (+44...) |
| `greeting`, `assistant_name` | First thing callers hear |
| `business_info`, `services`, `faqs` | The only facts the agent will state |
| `hours` | Opening hours, also used for transfer rules |
| `qualification.questions` / `hot_lead_criteria` | How leads are scored |
| `transfer_number` / `transfer_rules` | Leave `transfer_number` empty to disable transfers |
| `calendar.id` | Leave empty to disable booking |
| `notify.email` / `notify.webhook` | Where alerts go. `call_summaries: false` turns off per-call emails |
| `blocked_numbers` | Callers who will be rejected |

## Changing the agent's behaviour

The shared prompt is in `src/prompt.js` and the tools are in `src/tools.js`. After editing either, run `npm run setup-agent` again to update the agent. Choose a British voice in the Retell dashboard and copy its ID into `RETELL_VOICE_ID`.

## Running

```bash
cp .env.example .env    # then fill it in
npm test                # offline checks (voice agent, dashboard, sign-up/numbers/calendar)
npm start
```

## Before going live

- Tell callers they're speaking to an AI assistant. The greeting does this. Add a line to clients' privacy notices that calls may be recorded and processed by AI (UK GDPR).
- Never set `SKIP_SIGNATURE_CHECK=true` in production.
- `data/` (logins and call logs) and `tenants/` (client settings) are files on disk. Use a host with a persistent disk, or mount both as volumes with Docker, and back them up. Move to a database once you have dozens of clients.
- Clients can change their own business info, hours, FAQs, lead questions, transfer number and alerts. Only DBS admins can change phone numbers, diary settings, pricing, or pause a client.
- Reselling: Retell bills you per minute. Charge clients a monthly fee plus minutes. The `calls.jsonl` log per client gives you the call durations to invoice from.

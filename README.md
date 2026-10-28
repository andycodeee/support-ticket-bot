# Support Ticket Bot (Roblox API + Discord)

One Node.js service that does three things:

1. **Receives tickets from Roblox** (`POST /support`) and hands out responses to Roblox (`GET /support/responses`, `POST /support/responses/ack`).
2. **Posts new tickets to a Discord support channel** as embeds with a **Send Response** button.
3. **Lets authorized staff respond** through a modal. The response is stored in the API and the embed is updated. Roblox then applies the refund when it processes the response.

Everything runs in one process and shares one SQLite database. Railway deployment is covered at the end.

---

## 1. Project layout

```
src/
  index.js            entry point: starts API + Discord bot
  config.js           loads and validates .env
  db.js               SQLite schema (persistent, WAL mode)
  logger.js           logs with secrets redacted
  server/app.js       HTTP API (Roblox + bot endpoints)
  bot/index.js        Discord client startup
  bot/poller.js       polls API for new tickets; posts embeds; prevents duplicates
  bot/interactions.js button + modal handling, permission checks
  bot/responses.js    sends responses to API, retries, updates embeds
  bot/embeds.js       embed and button builders
  bot/api.js          HTTP client for the API (retries, timeouts)
```

---

## 2. Local installation

Requirements: Node.js 20.11+ (22 LTS recommended).
1
```bash
cp .env.example .env     # then fill in every value
npm install
npm start
```

Health check: `curl http://localhost:3000/health` should return `{"ok":true}`.

---

## 3. Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `DISCORD_TOKEN` | Bot token (Discord Developer Portal → Bot → Reset Token). Secret. |
| `DISCORD_CLIENT_ID` | Application ID (General Information). Used for the invite URL. |
| `DISCORD_GUILD_ID` | Your server ID. Interactions from any other server are ignored. |
| `SUPPORT_CHANNEL_ID` | Channel where ticket embeds are posted. |
| `SUPPORT_ROLE_IDS` | Comma-separated role IDs allowed to respond. Server admins are always allowed. |
| `API_BASE_URL` | `https://api.bookscover.store` (or your own URL if different). |
| `API_SECRET` | Shared secret sent as `X-API-Secret` by Roblox and by the bot. Use 32+ random characters. Secret. |
| `POLL_INTERVAL_MS` | How often the bot checks for new tickets and retries queued responses. Default `10000`. |
| `DB_PATH` | SQLite file path. Local default `./data/support.sqlite`; Railway uses `/data/support.sqlite`. |
| `PORT` | HTTP port. Railway sets this automatically. |

To get role and channel IDs, enable Developer Mode in Discord (User Settings → Advanced), then right-click a channel or role and choose **Copy ID**.

Generate a secret with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

Secrets are never logged. The logger replaces the token and secret with `[REDACTED]` before printing anything.

---

## 4. Discord bot setup

1. Go to <https://discord.com/developers/applications> → **New Application**.
2. **Bot** tab → **Reset Token** → copy into `DISCORD_TOKEN`. Leave all privileged intents **off**. This bot needs none of them.
3. **General Information** tab → copy **Application ID** into `DISCORD_CLIENT_ID`.
4. The bot starts and logs an invite URL on first run. Open it, choose your server, and authorize. Or build it yourself:
   `https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot&permissions=84992`
   Required permissions: View Channel, Send Messages, Embed Links, Read Message History.
5. In the support channel, make sure the bot role can see and post there. Set channel permissions so the bot can post, and restrict who can view the channel as you like.

The bot uses plain interactions (buttons and modals), not slash commands, so there is nothing to register.

---

## 5. API reference

All `/support` routes require header `X-API-Secret: <API_SECRET>`. Missing or wrong secret returns `401`.

### Roblox endpoints (unchanged contract)

**`POST /support`** submits a ticket. Body `{ "userId": 123, "username": "Name", "category": "Bug", "explanation": "..." }`. Optional `requestId` for idempotent retries. Returns `201 { "id": 17, "status": "pending" }`. Returns `200 ... "duplicate": true` for a repeat.
Categories: `Report`, `FailedPurcahse`, `Bug`. The spelling of `FailedPurcahse` follows your spec. If Roblox sends a different spelling, change the `CATEGORIES` array in `src/server/app.js`.
Duplicate rules: the same `requestId` returns the existing ticket. With no `requestId`, an identical ticket from the same user and category within 30 seconds is treated as a duplicate.

**`GET /support/responses`** returns undelivered responses in your expected shape: `{ "responses": [{ "id": "unique-id", "userId": 123, "response": "message", "minutes": 500 }] }`. Each response is leased for 60 seconds so two game servers polling at once don't both receive it.

**`POST /support/responses/ack`** body `{ "id": "unique-id" }`. Marks the response delivered. It is never returned again. Repeated acks are safe and return `alreadyAcked: true`. Unknown IDs return `404`.

### Bot endpoints (new, required by the bot)

**`GET /support/tickets?afterId=0&limit=50`** lists tickets with ID greater than `afterId`. This is how the bot discovers new tickets.

**`POST /support/responses`** records an admin response. Body:
```json
{ "id": "3f1c…-uuid", "ticketId": 17, "userId": 123, "response": "Your issue is resolved.", "minutes": 500, "responderId": "<discord user id>" }
```
`id` is idempotent: sending the same ID again returns success without a duplicate. One response per ticket: a second response for the same ticket returns `409 already_answered`.

### Quick curl test

```bash
S=your_api_secret
curl -s -X POST http://localhost:3000/support -H "X-API-Secret: $S" -H 'Content-Type: application/json' \
  -d '{"userId":123,"username":"TestPlayer","category":"Bug","explanation":"Button does nothing"}'
curl -s http://localhost:3000/support/tickets -H "X-API-Secret: $S"
curl -s http://localhost:3000/support/responses -H "X-API-Secret: $S"
```

---

## 6. How a ticket flows

1. Roblox calls `POST /support`. The ticket is stored with status `pending`.
2. Within `POLL_INTERVAL_MS`, the bot sees it, posts an embed (player, user ID, category, explanation, timestamp, status Pending) with one **Send Response** button, and records the Discord message ID in SQLite. A restart does not re-post tickets, because the cursor and per-ticket records are persisted.
3. A permitted admin clicks **Send Response**. The modal asks for Response (required, paragraph) and Minutes (optional, whole number, empty means 0).
4. The bot assigns a UUID, stores the response as `queued`, and calls `POST /support/responses`.
   - On success the state becomes `sent`, the embed switches to Answered (response, minutes, responder, timestamp), and the button is removed.
   - On a network error or 5xx, the response stays `queued` and the poller retries with the same UUID, so the API never records it twice.
   - On a permanent rejection (already answered, etc.), the state becomes `rejected`, the button is removed, and the embed shows the notice.
5. Roblox calls `GET /support/responses`, applies the minutes refund, then calls `POST /support/responses/ack`. Acked responses are never delivered again.

Discord's 3-second interaction limit is handled by responding to the modal immediately with a deferred reply, then doing the API call.

---

## 7. Roblox game notes (no changes to game code)

The game keeps doing exactly what it did:

- `POST /support` with `X-API-Secret` and `{ userId, username, category, explanation }`
- `GET /support/responses`, grant `minutes` (refund) for each response, then `POST /support/responses/ack` with `{ id }`

Acknowledge only after the refund is applied. If the game crashes between grant and ack, the response comes back after the 60-second lease. Because of that, the game should check whether it already granted a response ID (for example, store granted IDs in a DataStore) if double refunds are a concern. This is the one place where exactly-once depends on the game.

Response bodies: `POST /support` returns `201` (success) and the ack returns `200`. Both are 2xx, so typical `HttpService` success checks still work.

---

## 8. Deploying to Railway

Run **one replica only**. SQLite is a single-file database, so scaling beyond one instance corrupts state.

1. **Push the project to GitHub** (`.env` is git-ignored, so secrets stay out of the repo).
2. Railway dashboard → **New Project** → **Deploy from GitHub repo** → select the repo.
3. Open the service → **Settings** → make sure it is set to 1 replica.
4. **Volumes** (in the service's settings or canvas): **Add Volume**, mount path `/data`. This keeps the database across redeploys.
5. **Variables**: add every variable from `.env.example` with real values, plus:
   - `DB_PATH=/data/support.sqlite`
   - `API_BASE_URL=https://api.bookscover.store`
   - Leave `PORT` unset. Railway injects it, and the app reads it.
6. **Networking**: **Generate Domain** to test, or add a **Custom Domain** `api.bookscover.store`. Railway shows a CNAME target. Add that CNAME at your DNS provider, and Railway issues TLS automatically.
7. Deploy. Check the logs for `API listening on port …` and `Discord bot ready as …`.
8. Verify: `https://api.bookscover.store/health` returns `{"ok":true}`.
9. Restart policy: keep the default **On Failure**. If the Discord token is wrong, the process exits and Railway shows it clearly in logs.

If you use Railway's CLI instead: `railway login`, `railway link`, `railway up`, then set variables with `railway variables --set KEY=value`.

Node version: Railway picks Node from `engines` in `package.json` (>=20.11). `better-sqlite3` ships prebuilt binaries for Linux, so no compiler is needed.

Backups: the database is at `/data/support.sqlite`. Use Railway's volume backup feature, or periodically copy the file out.

---

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| `Missing required environment variable` | Fill in that variable in `.env` or Railway Variables. |
| Bot logs `Support channel is missing…` | Check `SUPPORT_CHANNEL_ID` and that the bot was invited to that server. |
| Button says you don't have permission | Add your role to `SUPPORT_ROLE_IDS` (comma-separated), or give yourself Administrator. |
| Roblox gets `401` | `API_SECRET` in the game must match the server exactly. |
| Responses show "queued" repeatedly | The API is unreachable or `API_BASE_URL` is wrong. The bot retries automatically. |
| Commands fail with `Interaction has already been acknowledged` | Make sure nothing else is responding to the same button. |

---

## 10. Security notes

- Credentials live only in environment variables. Nothing is hardcoded, and the logger redacts them.
- The `X-API-Secret` comparison uses a constant-time check.
- Admin actions are checked on both button click and modal submit, and only in the configured guild.
- Discord mentions are disabled on embeds, so responses cannot ping @everyone.
- Input is validated on both the API and the bot side. Minutes are non-negative whole numbers capped at 1,000,000,000.

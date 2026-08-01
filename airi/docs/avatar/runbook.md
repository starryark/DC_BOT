# Synchronized Discord avatar runbook

## Boundaries and startup

Secrets belong only in the relay and bot environments. Never put the publisher
token, Discord client secret, or session-signing secret in `VITE_*` variables.
The browser receives a short-lived, room-scoped relay token only after Discord
OAuth and guild membership checks.

Start in this order:

1. Start the relay on loopback and verify `/livez` and `/readyz`.
2. Expose it through an HTTPS tunnel or TLS reverse proxy.
3. Start the bot with `AVATAR_ENABLED=true`, a `wss://.../ws/publisher` URL, and
   the matching publisher token.
4. Build/deploy the Activity, configure Discord URL mappings, then launch it
   from the bot's active voice channel.

The bot keeps one ordered update in flight until the relay acknowledges it.
Unacknowledged updates and disconnect tombstones survive reconnects. Every
reconnect also publishes a new active sequence, which restores state after an
in-memory relay restart.

## Discord URL mappings

Configure Developer Portal mappings on the Activity's public HTTPS origin:

| Activity path | Upstream |
| --- | --- |
| `/relay/api` | `https://<relay-public-host>/api` |
| `/relay/ws` | `wss://<relay-public-host>/ws` |

Use `VITE_AVATAR_RELAY_HTTP_URL=/relay` and the mapped viewer WSS URL. The HTTP
exchange should remain same-origin; no broad CORS policy is required. For local
development, an HTTPS-capable tunnel (for example Cloudflare Tunnel or ngrok)
must forward both HTTP upgrades and ordinary requests to `127.0.0.1:8080`.

## Manual two-viewer acceptance

This flow requires Discord test credentials, the public tunnel, and the
licensed Phase 1 model:

1. Join the bot to a voice channel and open the Activity as two Discord users.
2. Confirm both viewers receive the same initial Idle snapshot.
3. With the debug command enabled and Manage Server permission, issue each
   `/avatar-state` behavior and confirm both viewers change together.
4. Confirm Speaking uses a distinct pink status accent but keeps mouth movement
   disabled (`speaking=false`, `mouthOpen=0`).
5. Stop and restart the relay. Confirm both viewers reconnect with fresh OAuth
   and the bot restores the active session.
6. Disconnect the bot. Confirm both viewers show “Avatar session disconnected,”
   force Idle, and remain subscribed. Rejoin the same channel and confirm both
   receive the new session.

Expected result: viewers stay room-isolated and synchronized; stale or retired
session frames do not roll state back; no token or raw relay frame appears in
user-facing errors or logs.

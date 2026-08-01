# Discord Activity Live2D

This app renders the configured licensed Live2D model and subscribes to avatar
state scoped to Discord's current guild/channel. Discord authorization, relay
exchange, and SDK authentication run before every WebSocket connection so a
reconnect never reuses an expired five-minute viewer token.

Production uses same-origin Discord URL mappings:

- `/relay/api/*` → relay HTTPS `/api/*`
- `/relay/ws/*` → relay WSS `/ws/*`

Set `VITE_AVATAR_RELAY_HTTP_URL=/relay` and
`VITE_AVATAR_RELAY_WS_URL=wss://<discord-mapped-origin>/relay/ws/viewer`. Put
the licensed model under `public/models/airi/` as described there, then run
`pnpm -F @proj-airi/discord-activity-live2d build`.

See [`docs/avatar/runbook.md`](../../docs/avatar/runbook.md) for the full setup.

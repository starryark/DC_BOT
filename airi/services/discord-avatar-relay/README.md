# Discord avatar relay

The relay is the only public backend for the Discord Activity. It accepts one
trusted bot publisher at `/ws/publisher`, viewer sockets at `/ws/viewer`, and
Discord OAuth exchanges at `/api/auth/discord`. State and subscriptions are
in-memory; an active bot republishes a fresh sequence after a relay restart.

Copy `.env.example`, set both Discord OAuth values and two independent random
secrets, then run:

```sh
pnpm -F @proj-airi/discord-avatar-relay start
```

Keep `PUBLISH_SECRET`, `DISCORD_CLIENT_SECRET`, and `SESSION_SIGNING_SECRET`
server-side. The default listener is loopback. A non-loopback listener requires
an HTTPS `PUBLIC_BASE_URL`; terminate TLS at the tunnel or reverse proxy.

See [`docs/avatar/runbook.md`](../../docs/avatar/runbook.md) for URL mappings,
startup order, health checks, and acceptance steps.

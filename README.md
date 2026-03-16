# status

super simple cf worker based uptime / status dashboard running [infra.dunkirk.sh](https://infra.dunkirk.sh).

The canonical repo for this is hosted on tangled over at [`dunkirk.sh/status`](https://tangled.org/dunkirk.sh/status)

## API

### `GET /api/status`
Overall summary with all machines and services.
```json
{
  "ok": true,
  "status": "up",
  "last_check": 1741900245,
  "machines": [{
    "name": "orion",
    "hostname": "orion",
    "type": "server",
    "online": true,
    "status": "up",
    "services": [{
      "id": "l4",
      "status": "up",
      "latency_ms": 42,
      "uptime_90d": 99.84
    }]
  }]
}
```

### `GET /api/status/overall`
Lightweight overall summary.
```json
{
  "ok": true,
  "status": "up",
  "uptime_90d": 99.84,
  "services_total": 20,
  "services_monitored": 16,
  "machines_total": 4
}
```

### `GET /api/status/service/:id`
Single service status.
```json
{
  "id": "l4",
  "status": "up",
  "latency_ms": 42,
  "uptime_90d": 99.84
}
```

### `GET /api/status/machine/:name`
Machine and all its services.
```json
{
  "name": "orion",
  "hostname": "orion",
  "type": "server",
  "online": true,
  "status": "up",
  "services": [{
    "id": "l4",
    "status": "up",
    "latency_ms": 42,
    "uptime_90d": 99.84
  }]
}
```

### `GET /api/uptime/:service_id`
Hourly uptime buckets for a service. Optional `?window=<days>` param (default: 90).
```json
{
  "service_id": "l4",
  "window_hours": 2160,
  "buckets": [{
    "timestamp": 1741896000,
    "status": "up"
  }]
}
```

**Status values:** `up` · `degraded` · `down` · `partial` · `timeout` · `misconfigured` · `unknown`

## Badges

```
/badge                        # overall infra status
/badge/overall                # same as above
/badge/service/:id            # single service
/badge/machine/:name          # machine status
```

**Query params:**

| Param    | Description                         | Example                |
| -------- | ----------------------------------- | ---------------------- |
| `style`  | `flat` (default) or `for-the-badge` | `?style=for-the-badge` |
| `colorA` | Label background (hex)              | `?colorA=363a4f`       |
| `colorB` | Value background (hex)              | `?colorB=b7bdf8`       |
| `label`  | Override label text                 | `?label=my+service`    |

## Setup

```bash
bun install
wrangler d1 create status-db
wrangler kv namespace create KV
# update wrangler.toml with the IDs
bun run db:migrate:local
wrangler secret put TAILSCALE_API_KEY
bun run dev
```

## Deploy

```bash
bun run deploy
bun run db:migrate
```

<p align="center">
    <img src="https://raw.githubusercontent.com/taciturnaxolotl/carriage/main/.github/images/line-break.svg" />
</p>

<p align="center">
    <i><code>&copy; 2026-present <a href="https://dunkirk.sh">Kieran Klukas</a></code></i>
</p>

<p align="center">
    <a href="https://tangled.org/dunkirk.sh/status/blob/main/LICENSE.md"><img src="https://img.shields.io/static/v1.svg?style=for-the-badge&label=License&message=O'Saasy&logoColor=d9e0ee&colorA=363a4f&colorB=b7bdf8"/></a>
</p>

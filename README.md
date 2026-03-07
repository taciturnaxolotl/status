# status

super simple cf worker based uptime / status dashboard running [infra.dunkirk.sh](https://infra.dunkirk.sh).

The canonical repo for this is hosted on tangled over at [`dunkirk.sh/status`](https://tangled.org/dunkirk.sh/status)

## API

```
/api/status                    # overall summary (ok, status, uptime, counts)
/api/status/overall            # same as above
/api/status/service/:id        # single service status + latency + uptime
/api/status/machine/:name      # machine online status + all its services
/api/uptime/:service_id        # hourly uptime buckets for a service
```

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

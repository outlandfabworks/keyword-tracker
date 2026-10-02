# Keyword Tracker

A self-hosted Google Trends tracker for a niche. Give it a few seed keywords and it finds related and rising searches on its own. It ranks them by popularity and momentum and refreshes every week. Everything runs in one Docker container with a web UI.

![Rankings](docs/rankings.png)

| Keyword detail (dark mode) | Settings |
|---|---|
| ![Keyword detail](docs/keyword-detail.png) | ![Settings](docs/settings.png) |

## Features

- **Auto-discovery**: each refresh pulls Google's rising and popular related searches for your seeds, so new keywords show up without you adding them.
- **Ranked top list**: a blend of popularity and momentum (last 4 weeks vs. the 12 before). A slider in Settings sets the balance.
- **Pins**: keywords you pin always appear in the list, with an optional note.
- **Country breakdown** for the ranked keywords. The rest of the pool is skipped to save requests.
- **History**: every weekly snapshot is kept, and you can open any past one.
- **Weekly schedule** with catch-up: if the machine was off at refresh time, it runs when the machine comes back.
- **Light/dark mode** that follows your system, and works on phones.
- **SQLite storage**: one file you can back up, query or export.

## Install

You need Docker with the Compose plugin.

```sh
git clone https://github.com/outlandfabworks/keyword-tracker.git
cd keyword-tracker
cp .env.example .env        # set your time zone; optionally a password
docker compose up -d
```

Open **http://localhost:8090**, or `http://<server-ip>:8090` from another device. The first refresh starts automatically within a minute of the first launch and takes around 10 minutes. Meanwhile, set your seed keywords under **Settings**.

### Pre-built image

To skip building, replace `build: .` in `docker-compose.yml` with:

```yaml
    image: ghcr.io/outlandfabworks/keyword-tracker:latest
```

Images are published for `amd64` and `arm64` (e.g. Raspberry Pi 4/5).

### Adding it to an existing compose stack

```yaml
  keyword-tracker:
    image: ghcr.io/outlandfabworks/keyword-tracker:latest
    restart: unless-stopped
    ports:
      - "8090:8090"
    environment:
      TZ: "America/New_York"
      KWT_PASSWORD: ""          # optional login
    volumes:
      - ./data/keyword-tracker:/data
```

## Configuration

Most settings are in the web UI: seeds, ignored words, comparison keyword, region, time range, ranking balance, list size and schedule. They're stored in the database. `config.toml` only supplies defaults for the first start.

Environment variables (in `.env`):

| Variable | Default | Purpose |
|---|---|---|
| `TZ` | `UTC` | Time zone for the weekly schedule |
| `KWT_PORT` | `8090` | Port for the web UI |
| `KWT_PASSWORD` | *(empty)* | If set, the UI asks for a login (any username, this password) |

## How the numbers work

Google Trends doesn't publish search counts. It gives a 0–100 scale relative to the other terms in the same request, with at most 5 terms per request. To compare dozens of keywords:

1. Every request includes a **comparison keyword** ("overlanding" by default) plus 4 others, and every value is divided by the comparison keyword's average. **Popularity 2×** means searched twice as often as the comparison keyword.
2. Google scales each request so its biggest term peaks at 100. That means a small keyword batched with a huge one comes back as rounding noise. Those keywords are fetched a second time alongside similar-sized ones.
3. **Momentum** compares average interest in the last 4 weeks to the 12 weeks before.
4. **Score** ranks every keyword on both measures and blends the two ranks. Pinned keywords always make the list.
5. **Countries** are Google's per-country share of searches, where 100 is the country where the keyword is most popular relative to its size. Countries and territories under about 1 million people are hidden by default, because a handful of searches can put them on top.

## Good to know

- **It uses an unofficial API.** Data comes from [pytrends](https://github.com/GeneralMills/pytrends), which scrapes Google Trends and is no longer maintained. Google can change things and break it at any time. All Google-facing code is in `tracker/trends.py`, so it's one file to replace if that happens.
- **Rate limits.** Google throttles aggressive clients, so refreshes pause 8–15 seconds between requests and back off on errors. A refresh takes around 10 minutes. If the History tab shows frequent "Partial" refreshes, raise the delays under Settings → Advanced.
- **Security.** There's no login unless you set `KWT_PASSWORD`. Run it on your home network or behind a VPN or reverse proxy; don't expose it directly to the internet.
- Not affiliated with Google.

## Backup, update, remove

```sh
cp -r data/ backup/                              # all history, pins and settings live in data/keywords.db
git pull && docker compose up -d --build         # update (or `docker compose pull && docker compose up -d` with the pre-built image)
docker compose down && rm -rf data/              # remove
```

## Command line (optional)

```sh
docker compose exec keyword-tracker python -m tracker top
docker compose exec keyword-tracker python -m tracker pin "tube bender" --note "core product"
docker compose exec keyword-tracker python -m tracker pins
```

## Development

```sh
docker build -t keyword-tracker:test .
docker run --rm -v "$PWD/tests:/app/tests:ro" keyword-tracker:test python -m unittest -v
```

The code is in `tracker/`:

| File | What it does |
|---|---|
| `trends.py` | Google access |
| `pipeline.py` | One refresh, start to finish |
| `ranking.py` | Pure scoring functions |
| `web.py` | API and scheduler |
| `static/` | The UI, plain JS with no build step |

The tests don't call Google; they use a fake client that mimics its scaling.

## License

[MIT](LICENSE)

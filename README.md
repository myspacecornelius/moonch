# Web Crawler Project

A small, hardened web crawler that demonstrates three scraping techniques in Python:
- REST API data fetching
- Static HTML scraping with BeautifulSoup
- JavaScript-rendered content with Selenium (headless Chrome)

## Project structure
```
moonch/
├── README.md
├── requirements.txt        # pinned runtime dependencies
├── requirements-dev.txt    # pinned lint / scan / test tooling
├── pyproject.toml          # pytest and ruff configuration
├── setup.sh                # creates ./venv and installs requirements
├── .env.example            # copy to .env (never commit .env)
├── .github/workflows/ci.yml
├── src/
│   ├── api_crawler.py      # WebCrawler implementation
│   └── example.py          # runnable examples
└── tests/
    └── test_api_crawler.py # offline tests against a local HTTP server
```

## Installation

Requires Python 3.9+ and, for the Selenium example, Chrome or Chromium.

```bash
./setup.sh                 # python3 -m venv venv && pip install -r requirements.txt
source venv/bin/activate
cp .env.example .env       # setup.sh does this if .env is missing
```

Edit `.env` and set `APOLLO_API_KEY`. The key is read from `.env` at startup
and sent only in the `X-Api-Key` header.

## Usage

```bash
python src/example.py
```

Each example runs in isolation and the run ends with a summary. The exit code is
`1` only if an example failed; a skipped example (for instance, no Apollo key)
does not fail the run.

### Selenium configuration

By default Selenium Manager locates Chrome and a matching ChromeDriver. Override
with environment variables (also read from `.env`):

| Variable | Purpose |
|---|---|
| `CHROME_BIN` | Path to the Chrome/Chromium binary |
| `CHROMEDRIVER_PATH` | Path to a pinned ChromeDriver matching that browser's major version |
| `CHROME_NO_SANDBOX=1` | Adds `--no-sandbox`. Only use inside an already-isolated container; it is added automatically when running as root. |

## Safety defaults

`WebCrawler` applies these on every request and exposes each as a constructor argument:

- connect/read timeout of 10 s / 30 s
- up to 3 retries with exponential backoff on connection errors and 429/5xx, for idempotent methods only
- response bodies capped at 10 MiB, enforced while streaming
- URLs must be `http`/`https` and must not target localhost or private/loopback IP literals unless `allow_private_hosts=True`
- query strings are stripped from log lines
- a fixed `User-Agent` identifying the crawler
- the browser starts on first use and is always closed by the context manager

## Development

```bash
pip install -r requirements-dev.txt
ruff check .                    # lint
bandit -q -r src                # static security scan
pip-audit -r requirements.txt   # dependency vulnerability audit
pytest                          # offline test suite
```

The same four checks run in GitHub Actions on every push and pull request.

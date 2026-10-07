"""Usage examples for WebCrawler.

Run from the repository root::

    python src/example.py

Each example runs in isolation; one failing cannot stop the others. The exit
code is 1 if any example failed, 0 if every example succeeded or was skipped.
"""

import json
import logging
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

from api_crawler import WebCrawler

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

OK, SKIPPED, FAILED = "ok", "skipped", "failed"
PLACEHOLDER_KEY = "your_api_key_here"


def example_apollo_api_call() -> str:
    """Search organisations through the Apollo.io API."""
    api_key = os.getenv("APOLLO_API_KEY")
    if not api_key or api_key == PLACEHOLDER_KEY:
        print("Skipping Apollo.io example: set APOLLO_API_KEY in .env")
        return SKIPPED

    # The key travels only in the auth header, never in the body or the URL,
    # so it cannot end up in logs or printed responses.
    headers = {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "X-Api-Key": api_key,
    }
    payload = {
        "q_organization_domains": ["example.com"],
        "page": 1,
        "per_page": 1,
    }

    with WebCrawler() as crawler:
        data = crawler.fetch_api_data(
            "https://api.apollo.io/v1/organizations/search",
            method="POST",
            headers=headers,
            json=payload,
        )
    print("\nApollo.io API Response:")
    print(json.dumps(data, indent=2))
    return OK


def example_web_scraping() -> str:
    """Scrape static HTML with BeautifulSoup."""
    with WebCrawler() as crawler:
        html_content = crawler.fetch_page_content("https://www.python.org")
        soup = crawler.parse_html(html_content)

    news_items = soup.select(".blog-widget li")
    print("\nLatest Python News:")
    for item in news_items[:3]:
        link = item.find("a")
        if link:
            print(f"- {link.text.strip()}")
    return OK


def example_selenium_scraping() -> str:
    """Scrape JavaScript-rendered content with headless Chrome."""
    with WebCrawler(use_selenium=True) as crawler:
        html_content = crawler.fetch_page_content("https://github.com/trending")
        soup = crawler.parse_html(html_content)

    repos = soup.select("h2.h3.lh-condensed")
    print("\nTrending GitHub Repositories:")
    for repo in repos[:3]:
        link = repo.find("a")
        if link:
            print(f"- {' '.join(link.text.split())}")
    return OK


EXAMPLES = (
    ("Apollo.io API", example_apollo_api_call),
    ("BeautifulSoup scraping", example_web_scraping),
    ("Selenium scraping", example_selenium_scraping),
)


def main() -> int:
    print("Running Web Crawler Examples...")
    results = {}
    for name, example in EXAMPLES:
        try:
            results[name] = example()
        except Exception as exc:
            first_line = (str(exc) or exc.__class__.__name__).splitlines()[0]
            logger.error("%s failed: %s", name, first_line)
            results[name] = FAILED

    print("\nSummary:")
    for name, status in results.items():
        print(f"  {name}: {status}")
    return 1 if FAILED in results.values() else 0


if __name__ == "__main__":
    sys.exit(main())

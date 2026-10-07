"""Web crawler for REST APIs, static HTML, and JavaScript-rendered pages.

Hardening built in:
- every HTTP call has a connect/read timeout and bounded retries with backoff
- response bodies are capped at ``max_bytes`` while streaming
- URLs must be http/https and, by default, must not point at loopback or
  private addresses (basic SSRF guard; DNS rebinding is out of scope)
- query strings are never logged, so keys in URLs stay out of logs
- Selenium starts lazily, so a missing browser cannot break construction
- the browser and driver can be pinned with CHROME_BIN / CHROMEDRIVER_PATH
"""

import ipaddress
import json as jsonlib
import logging
import os
from typing import Any, Optional, Union
from urllib.parse import urlsplit

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from urllib3.util.retry import Retry

logger = logging.getLogger(__name__)

Timeout = Union[float, tuple[float, float]]

DEFAULT_TIMEOUT: tuple[float, float] = (10.0, 30.0)  # (connect, read) seconds
DEFAULT_MAX_BYTES = 10 * 1024 * 1024  # 10 MiB per response
DEFAULT_RETRIES = 3
DEFAULT_USER_AGENT = "moonch-web-crawler/1.0 (+https://github.com/myspacecornelius/moonch)"
ALLOWED_SCHEMES = frozenset({"http", "https"})
RETRY_STATUSES = (429, 500, 502, 503, 504)
_CHUNK_SIZE = 64 * 1024


class CrawlerError(Exception):
    """Base class for crawler failures."""


class UnsafeURLError(CrawlerError, ValueError):
    """Raised when a URL fails the safety checks."""


class ResponseTooLargeError(CrawlerError):
    """Raised when a response body exceeds the configured size cap."""


class UnexpectedContentTypeError(CrawlerError):
    """Raised when an API returns something other than JSON."""


def redact_url(url: str) -> str:
    """Return ``url`` without its query string or fragment, for safe logging."""
    return urlsplit(url)._replace(query="", fragment="").geturl()


def validate_url(url: str, allow_private_hosts: bool = False) -> None:
    """Reject URLs that are not http(s) or that target non-public hosts.

    Raises:
        UnsafeURLError: if the scheme is not http/https, the host is missing,
            or (unless ``allow_private_hosts``) the host is localhost or an
            IP literal that is loopback, private, link-local, or reserved.
    """
    parts = urlsplit(url)
    if parts.scheme.lower() not in ALLOWED_SCHEMES:
        raise UnsafeURLError(f"URL scheme must be http or https: {redact_url(url)}")
    host = parts.hostname
    if not host:
        raise UnsafeURLError(f"URL has no host: {redact_url(url)}")
    if allow_private_hosts:
        return
    if host == "localhost" or host.endswith(".localhost"):
        raise UnsafeURLError(f"URL points at localhost: {redact_url(url)}")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return  # a hostname, not an IP literal
    if not address.is_global:
        raise UnsafeURLError(f"URL points at a non-public address: {redact_url(url)}")


def _read_timeout(timeout: Timeout) -> float:
    return float(timeout[1] if isinstance(timeout, tuple) else timeout)


def _running_as_root() -> bool:
    geteuid = getattr(os, "geteuid", None)
    return geteuid is not None and geteuid() == 0


class WebCrawler:
    """Fetch API JSON, static HTML, or browser-rendered HTML with safe defaults."""

    def __init__(
        self,
        use_selenium: bool = False,
        timeout: Timeout = DEFAULT_TIMEOUT,
        max_bytes: int = DEFAULT_MAX_BYTES,
        retries: int = DEFAULT_RETRIES,
        user_agent: str = DEFAULT_USER_AGENT,
        allow_private_hosts: bool = False,
    ):
        """
        Args:
            use_selenium: Default for ``fetch_page_content``. The browser is
                started on first use, never here.
            timeout: Seconds, or a ``(connect, read)`` tuple, for every request.
            max_bytes: Largest response body that will be read.
            retries: Retries for connection errors and 429/5xx on idempotent
                requests, with exponential backoff and Retry-After support.
                Read timeouts are never retried.
            user_agent: Sent on every request so sites can identify the crawler.
            allow_private_hosts: Permit localhost and private-network targets.
        """
        self.timeout = timeout
        self.max_bytes = max_bytes
        self.allow_private_hosts = allow_private_hosts
        self._use_selenium = use_selenium
        self.driver = None

        self.session = requests.Session()
        self.session.headers["User-Agent"] = user_agent
        # read=False matches the requests default: a read timeout is never
        # retried (the server may already be acting on the request) and it
        # surfaces as requests.exceptions.Timeout rather than ConnectionError.
        retry = Retry(
            total=retries,
            connect=retries,
            read=False,
            status=retries,
            backoff_factor=0.5,
            status_forcelist=RETRY_STATUSES,
            allowed_methods=frozenset({"GET", "HEAD", "OPTIONS"}),
            respect_retry_after_header=True,
            raise_on_status=False,
        )
        adapter = HTTPAdapter(max_retries=retry)
        self.session.mount("https://", adapter)
        self.session.mount("http://", adapter)

    # ----------------------------------------------------------------- Selenium

    def _ensure_driver(self):
        if self.driver is None:
            self._setup_selenium()
        return self.driver

    def _setup_selenium(self) -> None:
        """Start headless Chrome.

        Honours CHROME_BIN (browser binary), CHROMEDRIVER_PATH (pinned driver;
        otherwise Selenium Manager resolves one) and CHROME_NO_SANDBOX=1.
        ``--no-sandbox`` disables Chrome's renderer sandbox, so it is only
        added on request or when running as root, where Chrome refuses to
        start without it.
        """
        options = Options()
        options.add_argument("--headless=new")
        options.add_argument("--disable-dev-shm-usage")
        options.add_argument(f"--user-agent={self.session.headers['User-Agent']}")
        chrome_bin = os.getenv("CHROME_BIN")
        if chrome_bin:
            options.binary_location = chrome_bin
        if os.getenv("CHROME_NO_SANDBOX") == "1" or _running_as_root():
            options.add_argument("--no-sandbox")

        driver_path = os.getenv("CHROMEDRIVER_PATH")
        service = Service(executable_path=driver_path) if driver_path else Service()
        try:
            driver = webdriver.Chrome(service=service, options=options)
        except Exception as exc:
            logger.error("Failed to initialize Selenium WebDriver: %s", _first_line(exc))
            raise
        read_timeout = _read_timeout(self.timeout)
        driver.set_page_load_timeout(read_timeout)
        driver.set_script_timeout(read_timeout)
        self.driver = driver
        logger.info("Selenium WebDriver initialized")

    # --------------------------------------------------------------------- HTTP

    def _read_limited(self, response: requests.Response) -> bytes:
        declared = response.headers.get("Content-Length")
        if declared and declared.isdigit() and int(declared) > self.max_bytes:
            raise ResponseTooLargeError(
                f"Response from {redact_url(response.url)} declares {declared} bytes, "
                f"limit is {self.max_bytes}"
            )
        chunks = []
        total = 0
        for chunk in response.iter_content(chunk_size=_CHUNK_SIZE):
            total += len(chunk)
            if total > self.max_bytes:
                raise ResponseTooLargeError(
                    f"Response from {redact_url(response.url)} exceeds {self.max_bytes} bytes"
                )
            chunks.append(chunk)
        return b"".join(chunks)

    def fetch_api_data(
        self,
        url: str,
        method: str = "GET",
        params: Optional[dict[str, Any]] = None,
        headers: Optional[dict[str, str]] = None,
        json: Optional[dict[str, Any]] = None,
        timeout: Optional[Timeout] = None,
    ) -> Any:
        """Call a JSON REST endpoint and return the decoded body.

        Raises:
            UnsafeURLError: the URL failed validation.
            requests.HTTPError: the server returned a 4xx/5xx status.
            requests.exceptions.Timeout / ConnectionError: network failure after retries.
            UnexpectedContentTypeError: the response is not JSON.
            ResponseTooLargeError: the body exceeds ``max_bytes``.
        """
        validate_url(url, self.allow_private_hosts)
        safe_url = redact_url(url)
        logger.info("Fetching API data from: %s", safe_url)
        try:
            response = self.session.request(
                method=method,
                url=url,
                params=params,
                headers=headers,
                json=json,
                timeout=timeout or self.timeout,
                stream=True,
            )
            with response:
                response.raise_for_status()
                content_type = response.headers.get("Content-Type", "")
                if "json" not in content_type.lower():
                    raise UnexpectedContentTypeError(
                        f"Expected a JSON response from {safe_url}, got {content_type!r}"
                    )
                body = self._read_limited(response)
        except requests.exceptions.RequestException as exc:
            logger.error("Error fetching API data from %s: %s", safe_url, _first_line(exc))
            raise
        return jsonlib.loads(body)

    def fetch_page_content(
        self,
        url: str,
        use_selenium: Optional[bool] = None,
        timeout: Optional[Timeout] = None,
    ) -> str:
        """Return the HTML of ``url``, via Selenium when requested."""
        validate_url(url, self.allow_private_hosts)
        safe_url = redact_url(url)
        if use_selenium is None:
            use_selenium = self._use_selenium
        logger.info("Fetching page content from: %s", safe_url)
        try:
            if use_selenium:
                driver = self._ensure_driver()
                driver.get(url)
                return driver.page_source
            response = self.session.get(url, timeout=timeout or self.timeout, stream=True)
            with response:
                response.raise_for_status()
                body = self._read_limited(response)
                encoding = response.encoding or "utf-8"
            return body.decode(encoding, errors="replace")
        except Exception as exc:
            logger.error("Error fetching page content from %s: %s", safe_url, _first_line(exc))
            raise

    def parse_html(self, html_content: str) -> BeautifulSoup:
        """Parse HTML with the lxml parser."""
        return BeautifulSoup(html_content, "lxml")

    # ---------------------------------------------------------------- lifecycle

    def close(self) -> None:
        """Release the browser and HTTP session. Safe to call more than once."""
        if self.driver is not None:
            try:
                self.driver.quit()
            except Exception as exc:
                logger.warning("Error while closing WebDriver: %s", _first_line(exc))
            finally:
                self.driver = None
        self.session.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()


def _first_line(exc: BaseException) -> str:
    """Exception text without Selenium's multi-line native stack dump."""
    text = str(exc) or exc.__class__.__name__
    return text.splitlines()[0]

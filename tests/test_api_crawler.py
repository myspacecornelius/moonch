"""Tests for api_crawler using a local stdlib HTTP server (no network)."""

import logging
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest
import requests

from api_crawler import (
    DEFAULT_USER_AGENT,
    ResponseTooLargeError,
    UnexpectedContentTypeError,
    UnsafeURLError,
    WebCrawler,
    redact_url,
    validate_url,
)

JSON = {"Content-Type": "application/json"}
HTML = {"Content-Type": "text/html; charset=utf-8"}


class _Handler(BaseHTTPRequestHandler):
    """Serves scripted (status, headers, body, delay) tuples in order."""

    script = []
    seen = []

    def do_GET(self):
        self._serve()

    def do_POST(self):
        self._serve()

    def _serve(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        cls = type(self)
        cls.seen.append((self.command, self.path, dict(self.headers), body))
        status, headers, payload, delay = cls.script.pop(0) if cls.script else (200, {}, b"", 0)
        if delay:
            time.sleep(delay)
        self.send_response(status)
        for key, value in headers.items():
            self.send_header(key, value)
        if "Content-Length" not in headers:
            self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):  # keep test output quiet
        pass


@pytest.fixture
def server():
    _Handler.script = []
    _Handler.seen = []
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    httpd.daemon_threads = True
    httpd.block_on_close = False
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield SimpleNamespace(url=f"http://127.0.0.1:{httpd.server_port}", handler=_Handler)
    httpd.shutdown()
    httpd.server_close()


def crawler(**kwargs):
    kwargs.setdefault("allow_private_hosts", True)
    kwargs.setdefault("retries", 0)
    return WebCrawler(**kwargs)


# ------------------------------------------------------------------ URL safety


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "ftp://example.com/x",
        "javascript:alert(1)",
        "http:///no-host",
        "http://localhost/admin",
        "http://api.localhost/",
        "http://127.0.0.1:8080/",
        "http://10.0.0.5/",
        "http://192.168.1.1/",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]/",
    ],
)
def test_validate_url_rejects_unsafe_targets(url):
    with pytest.raises(UnsafeURLError):
        validate_url(url)


def test_validate_url_allows_public_hosts_and_private_opt_in():
    validate_url("https://example.com/path?x=1")
    validate_url("http://127.0.0.1/", allow_private_hosts=True)


def test_crawler_rejects_unsafe_url_before_any_request(server):
    with WebCrawler() as c, pytest.raises(UnsafeURLError):
        c.fetch_page_content(server.url + "/")
    assert server.handler.seen == []


def test_redact_url_strips_query_and_fragment():
    assert redact_url("https://api.example.com/v1?api_key=SECRET#frag") == "https://api.example.com/v1"


# --------------------------------------------------------------------- HTTP API


def test_fetch_api_data_returns_json_and_identifies_itself(server):
    server.handler.script.append((200, JSON, b'{"ok": true, "n": 1}', 0))
    with crawler() as c:
        assert c.fetch_api_data(server.url + "/v1/items") == {"ok": True, "n": 1}
    method, path, headers, _ = server.handler.seen[0]
    assert (method, path) == ("GET", "/v1/items")
    assert headers["User-Agent"] == DEFAULT_USER_AGENT


def test_fetch_api_data_posts_json_body(server):
    server.handler.script.append((200, JSON, b"[]", 0))
    with crawler() as c:
        assert c.fetch_api_data(server.url + "/v1", method="POST", json={"a": 1}) == []
    method, _, headers, body = server.handler.seen[0]
    assert method == "POST"
    assert headers["Content-Type"] == "application/json"
    assert body == b'{"a": 1}'


def test_fetch_api_data_rejects_non_json_content_type(server):
    server.handler.script.append((200, HTML, b"<html></html>", 0))
    with crawler() as c, pytest.raises(UnexpectedContentTypeError):
        c.fetch_api_data(server.url + "/v1")


def test_fetch_api_data_raises_on_http_error(server):
    server.handler.script.append((401, JSON, b'{"error": "unauthorized"}', 0))
    with crawler() as c, pytest.raises(requests.HTTPError):
        c.fetch_api_data(server.url + "/v1")


# ------------------------------------------------------------------ robustness


def test_request_times_out_instead_of_hanging(server):
    server.handler.script.append((200, HTML, b"late", 2.0))
    start = time.monotonic()
    with crawler(timeout=0.3) as c, pytest.raises(requests.exceptions.Timeout):
        c.fetch_page_content(server.url + "/slow")
    assert time.monotonic() - start < 1.5


def test_transient_server_errors_are_retried(server):
    server.handler.script.append((503, HTML, b"busy", 0))
    server.handler.script.append((200, HTML, b"<p>hi</p>", 0))
    with crawler(retries=2) as c:
        assert "hi" in c.fetch_page_content(server.url + "/")
    assert len(server.handler.seen) == 2


def test_post_is_not_retried_on_server_error(server):
    server.handler.script.append((503, JSON, b"{}", 0))
    with crawler(retries=2) as c, pytest.raises(requests.HTTPError):
        c.fetch_api_data(server.url + "/v1", method="POST", json={})
    assert len(server.handler.seen) == 1


def test_declared_oversize_body_is_refused_before_download(server):
    server.handler.script.append((200, {**HTML, "Content-Length": "5000"}, b"x", 0))
    with crawler(max_bytes=1024) as c, pytest.raises(ResponseTooLargeError):
        c.fetch_page_content(server.url + "/big")


def test_undeclared_oversize_body_is_cut_off_while_streaming(server):
    server.handler.script.append((200, HTML, b"x" * 4096, 0))
    with crawler(max_bytes=1024) as c, pytest.raises(ResponseTooLargeError):
        c.fetch_page_content(server.url + "/big")


def test_query_string_never_reaches_logs(server, caplog):
    server.handler.script.append((200, JSON, b"{}", 0))
    with caplog.at_level(logging.INFO, logger="api_crawler"), crawler() as c:
        c.fetch_api_data(server.url + "/v1?api_key=SECRET-VALUE")
    assert "SECRET-VALUE" not in caplog.text
    assert "/v1" in caplog.text


# -------------------------------------------------------------------- Selenium


def test_browser_is_not_started_at_construction():
    with WebCrawler(use_selenium=True) as c:
        assert c.driver is None


def test_browser_starts_lazily_and_is_closed(monkeypatch):
    events = []

    class FakeDriver:
        page_source = "<html><body>rendered</body></html>"

        def get(self, url):
            events.append(("get", url))

        def quit(self):
            events.append(("quit", None))

    def fake_setup(self):
        events.append(("setup", None))
        self.driver = FakeDriver()

    monkeypatch.setattr(WebCrawler, "_setup_selenium", fake_setup)
    with WebCrawler(use_selenium=True) as c:
        assert c.driver is None
        html = c.fetch_page_content("https://example.com/")
    assert "rendered" in html
    assert events == [("setup", None), ("get", "https://example.com/"), ("quit", None)]
    assert c.driver is None


def test_browser_failure_is_raised_not_swallowed(monkeypatch):
    def failing_setup(self):
        raise RuntimeError("cannot find Chrome binary")

    monkeypatch.setattr(WebCrawler, "_setup_selenium", failing_setup)
    with WebCrawler(use_selenium=True) as c, pytest.raises(RuntimeError):
        c.fetch_page_content("https://example.com/")

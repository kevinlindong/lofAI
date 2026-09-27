"""Small, bounded HTTP client for the explicitly supported integration APIs."""

import json
import socket
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class IntegrationError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


API_HOSTS = {
    "tasks.googleapis.com", "www.googleapis.com", "gmail.googleapis.com",
    "oauth2.googleapis.com", "graph.microsoft.com", "login.microsoftonline.com",
    "api.todoist.com", "api.notion.com", "api.linear.app", "api.github.com",
    "api.trello.com", "app.asana.com", "slack.com", "discord.com",
}
MAX_RESPONSE = 4 * 1024 * 1024


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request_json(method: str, url: str, token: str | None = None,
                 body: dict | list | None = None, headers: dict | None = None):
    """Return JSON without following redirects or exposing remote error bodies.

    An explicit form content type is supported for OAuth's token endpoint.
    API credentials never leave this fixed set of HTTPS hosts.
    """
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or parsed.hostname not in API_HOSTS
            or parsed.port not in (None, 443) or parsed.username or parsed.password
            or parsed.fragment):
        raise IntegrationError("This service address is not supported.")
    req_headers = {"Accept": "application/json", "User-Agent": "LofAI/1.0"}
    if token:
        if any(ord(char) < 32 or ord(char) > 126 for char in token):
            raise IntegrationError("That access token has an unexpected character.")
        req_headers["Authorization"] = f"Bearer {token}"
    req_headers.update(headers or {})
    payload = None
    if body is not None:
        if req_headers.get("Content-Type") == "application/x-www-form-urlencoded":
            payload = urlencode(body).encode()
        else:
            payload = json.dumps(body).encode()
            req_headers["Content-Type"] = "application/json"
    request = Request(url, data=payload, headers=req_headers, method=method)
    try:
        with build_opener(_NoRedirect()).open(request, timeout=18) as response:
            raw = response.read(MAX_RESPONSE + 1)
        if len(raw) > MAX_RESPONSE:
            raise IntegrationError("This service sent too much at once. Try a smaller source.", 502)
        result = json.loads(raw) if raw else {}
        # Several completion endpoints return JSON null on success.
        if result is None:
            return {}
        if not isinstance(result, (dict, list)):
            raise IntegrationError("This service sent an unexpected response. Try again.", 502)
        return result
    except HTTPError as error:
        error.close()
        if error.code == 401:
            raise IntegrationError("This connection has expired. Reconnect to bring it back.", 401) from None
        if error.code == 403:
            raise IntegrationError("This connection needs permission for that action. Check its access and reconnect.", 403) from None
        if error.code == 404:
            raise IntegrationError("That item or source is no longer available. Refresh your list.", 404) from None
        if error.code == 429:
            raise IntegrationError("This service needs a little breather. Try again in a minute.", 429) from None
        raise IntegrationError("The service could not accept that request. Check the setup and try again.", 502) from None
    except (URLError, TimeoutError, socket.timeout, OSError):
        raise IntegrationError("This service is out of reach for a moment. Your local tasks are still here.", 502) from None
    except (ValueError, UnicodeError):
        raise IntegrationError("This service sent an unexpected response. Try again.", 502) from None

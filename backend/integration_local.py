"""Native Reminders and explicit, outbound-only automation webhooks.

Connecting a webhook only validates its configuration. No request is made until
send() is called. Reminders scripts never interpolate user-supplied source IDs.
"""

import http.client
import ipaddress
import json
import os
import re
import socket
import ssl
import subprocess
import sys
from urllib.parse import urlsplit

from integration_http import IntegrationError

PROVIDERS = {"apple-reminders", "n8n", "zapier"}
WEBHOOK_PROVIDERS = {"n8n", "zapier"}
PAGE_SIZE = 100
REMINDERS_TIMEOUT = 25
WEBHOOK_TIMEOUT = 18
MAX_SCRIPT_RESPONSE = 1024 * 1024
MAX_WEBHOOK_PAYLOAD = 16 * 1024

_LISTS_SCRIPT = r'''
function run(argv) {
    var app = Application("com.apple.reminders");
    var lists = app.lists();
    if (lists.length > 500) return JSON.stringify({error: "too-many-lists"});
    return JSON.stringify(lists.map(function (list) {
        return {id: String(list.id()), name: String(list.name()).slice(0, 300)};
    }));
}
'''

_ITEMS_SCRIPT = r'''
function run(argv) {
    var app = Application("com.apple.reminders");
    var list = app.lists.byId(argv[0]);
    if (!list.exists()) return JSON.stringify({error: "missing-list"});
    var offset = Number(argv[1]);
    var rows = list.reminders();
    var page = rows.slice(offset, offset + 100).map(function (reminder) {
        return {
            id: String(reminder.id()),
            title: String(reminder.name()).slice(0, 1000),
            done: Boolean(reminder.completed()),
            kind: "task"
        };
    });
    return JSON.stringify({items: page, nextCursor: offset + 100 < rows.length ? String(offset + 100) : null});
}
'''

_COMPLETE_SCRIPT = r'''
function run(argv) {
    var app = Application("com.apple.reminders");
    var list = app.lists.byId(argv[0]);
    if (!list.exists()) return JSON.stringify({error: "missing-list"});
    var reminder = list.reminders.byId(argv[1]);
    if (!reminder.exists()) return JSON.stringify({error: "missing-item"});
    var done = argv[2] === "true";
    reminder.completed = done;
    return JSON.stringify({done: Boolean(reminder.completed())});
}
'''


def _id(value):
    if (not isinstance(value, str) or not value or len(value) > 2048
            or any(ord(char) < 32 for char in value)):
        raise IntegrationError("Choose a valid reminder or list first.")
    return value


def _reminders(creds, script, *args):
    if sys.platform != "darwin":
        raise IntegrationError("Apple Reminders needs LofAI's backend running on your Mac.")
    if creds.get("token") != "native":
        raise IntegrationError("Reconnect Apple Reminders using the native Mac connection.")
    try:
        result = subprocess.run(
            ["/usr/bin/osascript", "-l", "JavaScript", "-e", script, "--", *args],
            capture_output=True, text=True, timeout=REMINDERS_TIMEOUT, check=False,
        )
    except subprocess.TimeoutExpired:
        raise IntegrationError("Reminders took a little too long. Check the Mac's permission prompt, then try again.", 504) from None
    except OSError:
        raise IntegrationError("The Mac's Reminders bridge is unavailable. Open Reminders on the backend Mac and reconnect.", 503) from None
    if result.returncode:
        if "-1743" in result.stderr or "not authorized" in result.stderr.lower():
            raise IntegrationError("Allow the app running LofAI to control Reminders in System Settings → Privacy & Security → Automation, then reconnect.", 403)
        raise IntegrationError("Reminders could not finish that request. Open it on the backend Mac, check Automation permission, and try again.", 502)
    if len(result.stdout.encode("utf-8")) > MAX_SCRIPT_RESPONSE:
        raise IntegrationError("That Reminders list is too large to read at once.", 502)
    try:
        data = json.loads(result.stdout)
    except (ValueError, UnicodeError):
        raise IntegrationError("Reminders sent an unexpected response. Try reconnecting.", 502) from None
    if isinstance(data, dict) and data.get("error"):
        if data["error"] == "too-many-lists":
            raise IntegrationError("There are too many Reminders lists to show at once. Keep fewer than 500 lists available.")
        if data["error"] == "missing-list":
            raise IntegrationError("That Reminders list has moved. Refresh your lists.", 404)
        if data["error"] == "missing-item":
            raise IntegrationError("That reminder has moved. Refresh its list.", 404)
        raise IntegrationError("Reminders could not finish that request.", 502)
    return data


def _webhook_url(provider, creds):
    if provider not in WEBHOOK_PROVIDERS:
        raise IntegrationError("This service does not accept automation deliveries.")
    url = creds.get("token")
    if (not isinstance(url, str) or not url or len(url) > 4096
            or any(ord(char) < 33 or ord(char) > 126 for char in url) or "\\" in url):
        raise IntegrationError("Paste the complete HTTPS webhook URL from your automation.")
    try:
        parsed = urlsplit(url)
        valid = (parsed.scheme == "https" and parsed.hostname
                 and parsed.port in (None, 443) and parsed.username is None
                 and parsed.password is None and not parsed.fragment)
    except ValueError:
        valid = False
    if not valid:
        raise IntegrationError("Use an HTTPS webhook URL without a login or fragment.")
    host = parsed.hostname
    if (not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", host)
            or ".." in host or host == "localhost" or host.endswith(".localhost")
            or host.endswith(".local")):
        raise IntegrationError("Use a public webhook hostname.")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        raise IntegrationError("Use a public webhook hostname rather than an IP address.")
    if provider == "zapier":
        if host != "hooks.zapier.com" or not re.fullmatch(r"/hooks/catch/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+/?", parsed.path):
            raise IntegrationError("Use the Catch Hook URL copied from Webhooks by Zapier.")
    else:
        allowed = {entry.strip().lower() for entry in os.environ.get("LOFAI_WEBHOOK_HOSTS", "").split(",") if entry.strip()}
        if not host.endswith(".app.n8n.cloud") and host not in allowed:
            raise IntegrationError("Use your n8n Cloud webhook, or add your own n8n hostname to LOFAI_WEBHOOK_HOSTS on the backend.")
        if not parsed.path or parsed.path == "/":
            raise IntegrationError("Paste the full n8n webhook URL, including its path.")
    return parsed


def _public_addresses(host):
    try:
        addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except OSError:
        raise IntegrationError("That webhook host could not be reached. Check its URL and try again.", 502) from None
    if not addresses:
        raise IntegrationError("That webhook host could not be reached. Check its URL and try again.", 502)
    for family, socktype, proto, canonname, address in addresses:
        try:
            ip = ipaddress.ip_address(address[0])
        except ValueError:
            raise IntegrationError("That webhook must resolve to a public internet address.") from None
        if (family not in (socket.AF_INET, socket.AF_INET6) or not ip.is_global
                or ip.is_multicast or ip.is_unspecified
                or (getattr(ip, "ipv4_mapped", None) and not ip.ipv4_mapped.is_global)):
            raise IntegrationError("That webhook must resolve to a public internet address.")
    return addresses


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """Connect to validated numeric addresses; keep the hostname for TLS/SNI.

    Bypassing a second DNS lookup closes the validation-to-connect rebinding
    window. http.client also ignores HTTP(S)_PROXY and never follows redirects.
    """

    def __init__(self, host, addresses):
        super().__init__(host, timeout=WEBHOOK_TIMEOUT, context=ssl.create_default_context())
        self._addresses = addresses

    def connect(self):
        last_error = None
        # Retry only the connection stage, before any task payload is sent.
        for family, socktype, proto, canonname, address in self._addresses[:4]:
            sock = socket.socket(family, socktype, proto)
            sock.settimeout(self.timeout)
            try:
                sock.connect(address)
                self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
                return
            except OSError as error:
                sock.close()
                last_error = error
        raise last_error or OSError("No public webhook address is reachable")


def sources(provider, creds):
    if provider in WEBHOOK_PROVIDERS:
        _webhook_url(provider, creds)
        # Neither DNS nor a test delivery is needed to save this configuration.
        return [{"id": "outbound", "name": "Send a task to your workflow"}]
    if provider != "apple-reminders":
        raise IntegrationError("This service is not supported.", 404)
    data = _reminders(creds, _LISTS_SCRIPT)
    if not isinstance(data, list) or any(not isinstance(row, dict) or not isinstance(row.get("id"), str) or not isinstance(row.get("name"), str) for row in data):
        raise IntegrationError("Reminders sent an unexpected list. Try reconnecting.", 502)
    return [{"id": row["id"], "name": row["name"] or "Untitled list"} for row in data]


def items(provider, creds, source, cursor=None):
    if provider in WEBHOOK_PROVIDERS:
        _webhook_url(provider, creds)
        if source != "outbound":
            raise IntegrationError("Choose the outbound workflow first.")
        return {"items": [], "nextCursor": None}
    if provider != "apple-reminders":
        raise IntegrationError("This service is not supported.", 404)
    source = _id(source)
    if cursor is None:
        offset = 0
    elif not isinstance(cursor, str) or not re.fullmatch(r"[0-9]{1,7}", cursor):
        raise IntegrationError("That page has wandered off. Refresh this list.")
    else:
        offset = int(cursor)
    if offset > 1000000 or offset % PAGE_SIZE:
        raise IntegrationError("That page has wandered off. Refresh this list.")
    data = _reminders(creds, _ITEMS_SCRIPT, source, str(offset))
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        raise IntegrationError("Reminders sent an unexpected list. Try reconnecting.", 502)
    rows = data["items"]
    if len(rows) > PAGE_SIZE or any(not isinstance(row, dict) or not isinstance(row.get("id"), str) or not isinstance(row.get("title"), str) or not isinstance(row.get("done"), bool) for row in rows):
        raise IntegrationError("Reminders sent an unexpected list. Try reconnecting.", 502)
    next_cursor = data.get("nextCursor")
    if next_cursor is not None and next_cursor != str(offset + PAGE_SIZE):
        raise IntegrationError("Reminders sent an unexpected page. Refresh this list.", 502)
    return {"items": [{"id": row["id"], "title": row["title"] or "A little untitled thing", "done": row["done"], "kind": "task"} for row in rows], "nextCursor": next_cursor}


def complete(provider, creds, source, item_id, done):
    if provider != "apple-reminders":
        raise IntegrationError("This automation sends tasks outward. It does not synchronize checkmarks.")
    if not isinstance(done, bool):
        raise IntegrationError("Choose whether the reminder is done first.")
    data = _reminders(creds, _COMPLETE_SCRIPT, _id(source), _id(item_id), "true" if done else "false")
    if not isinstance(data, dict) or data.get("done") is not done:
        raise IntegrationError("Reminders did not confirm that checkmark. Refresh its list before trying again.", 502)


def send(provider, creds, payload):
    parsed = _webhook_url(provider, creds)
    if (not isinstance(payload, dict) or not isinstance(payload.get("title"), str)
            or not payload["title"].strip() or len(payload["title"]) > 2000
            or not isinstance(payload.get("done", False), bool)):
        raise IntegrationError("Choose a task with a title of up to 2,000 characters to send.")
    body = {"title": payload["title"].strip(), "done": payload.get("done", False)}
    url = payload.get("url")
    if url:
        if not isinstance(url, str) or len(url) > 2048 or any(ord(char) < 32 for char in url):
            raise IntegrationError("That task link is not a valid web address.")
        try:
            task_url = urlsplit(url)
            valid_url = task_url.scheme in {"http", "https"} and bool(task_url.hostname) and task_url.username is None and task_url.password is None
        except ValueError:
            valid_url = False
        if not valid_url:
            raise IntegrationError("That task link is not a valid web address.")
        body["url"] = url
    encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")
    if len(encoded) > MAX_WEBHOOK_PAYLOAD:
        raise IntegrationError("That task is too large to send. Shorten its title and try again.")
    connection = _PinnedHTTPSConnection(parsed.hostname, _public_addresses(parsed.hostname))
    target = parsed.path + ("?" + parsed.query if parsed.query else "")
    try:
        connection.request("POST", target, body=encoded, headers={
            "Content-Type": "application/json", "Accept": "application/json", "User-Agent": "LofAI/1.0",
        })
        response = connection.getresponse()
        # Success is the hook accepting this payload. Workflow completion is
        # outside this connection. Text and empty response bodies are both valid.
        if 200 <= response.status < 300:
            return {"delivered": True}
        if response.status == 429:
            raise IntegrationError("Your workflow needs a little breather. Try sending again in a minute.", 429)
        if 300 <= response.status < 400:
            raise IntegrationError("The webhook tried to redirect. Paste its direct HTTPS address and reconnect.", 502)
        raise IntegrationError("The webhook did not accept this task. Check that your workflow is active and its URL is current.", 502)
    except (OSError, http.client.HTTPException):
        raise IntegrationError("The webhook did not confirm delivery. Check your workflow's history before sending again.", 502) from None
    finally:
        connection.close()

"""Browser-scoped connections for the local LofAI workspace.

Provider tokens stay in a private backend database. The browser's random
X-Lofai-Client value is a bearer credential, not a public user identifier.
"""

import asyncio
import base64
from contextlib import contextmanager
import hashlib
import html
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import threading
import time
from urllib.parse import urlencode, urlsplit

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse

import integration_core
import integration_services
import integration_local
from integration_http import IntegrationError, request_json

router = APIRouter(prefix="/integrations", tags=["integrations"])
MODULES = (integration_core, integration_services, integration_local)
PROVIDERS = set().union(*(module.PROVIDERS for module in MODULES))
MAX_BODY = 16_384
OAUTH_CALLBACK = "/integrations/oauth/callback"
_refresh_lock = threading.Lock()
OAUTH_SCOPES = {
    "google-tasks": "https://www.googleapis.com/auth/tasks",
    "google-calendar": "https://www.googleapis.com/auth/calendar.readonly",
    "gmail": "https://www.googleapis.com/auth/gmail.readonly",
    "microsoft-todo": "offline_access Tasks.ReadWrite",
    "outlook-calendar": "offline_access Calendars.Read",
    "outlook-mail": "offline_access Mail.Read",
}


@contextmanager
def _db():
    directory = Path(os.environ.get("LOFAI_INTEGRATIONS_DIR", str(Path.home() / ".cache" / "lofai")))
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = directory / "integrations.sqlite3"
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
    os.fchmod(descriptor, 0o600)
    os.close(descriptor)
    connection = sqlite3.connect(path, timeout=10)
    try:
        connection.execute("PRAGMA secure_delete = ON")
        connection.execute("CREATE TABLE IF NOT EXISTS connections (client TEXT, provider TEXT, credentials TEXT NOT NULL, PRIMARY KEY(client, provider))")
        connection.execute("CREATE TABLE IF NOT EXISTS oauth_states (state TEXT PRIMARY KEY, client TEXT, provider TEXT, origin TEXT, verifier TEXT, expires REAL)")
        yield connection
        connection.commit()
    finally:
        connection.close()


def _allowed_origins():
    return {origin.strip() for origin in os.environ.get(
        "LOFAI_ALLOWED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000"
    ).split(",") if origin.strip() and origin.strip() != "*"}


def _check_location(request, mutation=False):
    origin = request.headers.get("origin")
    if (origin and origin not in _allowed_origins()) or (mutation and not origin):
        raise HTTPException(403, "Open this connection from your LofAI workspace.")
    if os.environ.get("LOFAI_INTEGRATIONS_ALLOW_REMOTE") != "1":
        try:
            local = ipaddress.ip_address(request.client.host).is_loopback
        except (ValueError, AttributeError):
            local = False
        if not local:
            raise HTTPException(403, "Connections are available on this computer only.")


def _identity(request, mutation=False):
    _check_location(request, mutation)
    credential = request.headers.get("x-lofai-client", "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", credential):
        raise HTTPException(401, "Reload your workspace to start a private connection.")
    return hashlib.sha256(credential.encode()).hexdigest()


def _adapter(provider):
    for module in MODULES:
        if provider in module.PROVIDERS:
            return module
    raise HTTPException(404, "That service isn't in this room yet.")


def _save(client, provider, creds):
    with _db() as db:
        db.execute("INSERT OR REPLACE INTO connections VALUES (?, ?, ?)", (client, provider, json.dumps(creds)))


def _load(client, provider):
    with _db() as db:
        row = db.execute("SELECT credentials FROM connections WHERE client=? AND provider=?", (client, provider)).fetchone()
    if row is None:
        raise IntegrationError("Connect this service first.", 401)
    return json.loads(row[0])


def _oauth_config(provider):
    if provider not in OAUTH_SCOPES:
        return None
    google = provider.startswith("google-") or provider == "gmail"
    prefix = "LOFAI_GOOGLE" if google else "LOFAI_MICROSOFT"
    client_id, secret = os.environ.get(prefix + "_CLIENT_ID"), os.environ.get(prefix + "_CLIENT_SECRET")
    if not client_id or not secret:
        return None
    redirect = os.environ.get("LOFAI_OAUTH_REDIRECT_URI", "http://localhost:8000" + OAUTH_CALLBACK)
    parsed = urlsplit(redirect)
    if (parsed.path != OAUTH_CALLBACK or parsed.query or parsed.fragment or parsed.username
            or (parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}))):
        return None
    return {
        "client_id": client_id, "client_secret": secret, "redirect_uri": redirect,
        "authorize": "https://accounts.google.com/o/oauth2/v2/auth" if google else "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        "token_url": "https://oauth2.googleapis.com/token" if google else "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        "scope": OAUTH_SCOPES[provider], "google": google,
    }


def _exchange(config, values):
    return request_json("POST", config["token_url"], body={
        "client_id": config["client_id"], "client_secret": config["client_secret"], **values,
    }, headers={"Content-Type": "application/x-www-form-urlencoded"})


def _credentials(client, provider):
    creds = _load(client, provider)
    if not creds.get("refresh_token") or creds.get("expires_at", 0) > time.time() + 60:
        return creds
    # Re-read under lock so simultaneous source/item requests reuse one refresh.
    with _refresh_lock:
        creds = _load(client, provider)
        if creds.get("expires_at", 0) > time.time() + 60:
            return creds
        config = _oauth_config(provider)
        if not config:
            raise IntegrationError("This connection needs its server OAuth setup restored.", 401)
        previous = json.dumps(creds)
        data = _exchange(config, {"grant_type": "refresh_token", "refresh_token": creds["refresh_token"]})
        if not isinstance(data.get("access_token"), str):
            raise IntegrationError("This connection has expired. Reconnect to bring it back.", 401)
        creds.update(token=data["access_token"], expires_at=time.time() + int(data.get("expires_in", 3600)))
        if data.get("refresh_token"):
            creds["refresh_token"] = data["refresh_token"]
        with _db() as db:
            changed = db.execute("UPDATE connections SET credentials=? WHERE client=? AND provider=? AND credentials=?",
                                 (json.dumps(creds), client, provider, previous)).rowcount
        if not changed:
            # A concurrent disconnect/reconnect takes precedence over an old
            # request's refresh result, including credentials for a new account.
            return _load(client, provider)
        return creds


async def _call(function, *args):
    try:
        return await asyncio.to_thread(function, *args)
    except IntegrationError as error:
        raise HTTPException(error.status, str(error)) from None
    except (AttributeError, KeyError, TypeError, ValueError):
        raise HTTPException(502, "This service sent an unexpected response. Try refreshing.") from None
    except (sqlite3.Error, OSError):
        raise HTTPException(503, "Your connection could not be saved on this computer. Check its storage and try again.") from None


async def _body(request):
    if request.headers.get("content-type", "").split(";", 1)[0] != "application/json":
        raise HTTPException(415, "Send this request as JSON.")
    content = bytearray()
    async for chunk in request.stream():
        content.extend(chunk)
        if len(content) > MAX_BODY:
            raise HTTPException(413, "That connection request is too large.")
    try:
        body = json.loads(content)
    except (ValueError, UnicodeError):
        raise HTTPException(400, "That request couldn't be read. Try again.") from None
    if not isinstance(body, dict):
        raise HTTPException(400, "Send a connection object.")
    return body


def _text(value, name, limit=2048, required=True):
    if value is None and not required:
        return ""
    if (not isinstance(value, str) or len(value) > limit or (required and not value.strip())
            or any(ord(char) < 32 for char in value)):
        raise HTTPException(400, f"Check the {name} and try again.")
    return value.strip()


def _safe_url(url):
    if not isinstance(url, str) or len(url) > 4096:
        return None
    try:
        parsed = urlsplit(url)
        return url if parsed.scheme == "https" and parsed.hostname and not parsed.username and not parsed.password else None
    except ValueError:
        return None


def _clean_items(result):
    cleaned = []
    for item in result.get("items", [])[:200]:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            continue
        value = {
            "id": item["id"][:2048], "title": str(item.get("title") or "A little untitled thing")[:2000],
            "done": item.get("done") is True,
            "kind": item.get("kind") if item.get("kind") in {"task", "event", "message"} else "task",
        }
        if _safe_url(item.get("url")):
            value["url"] = item["url"]
        if isinstance(item.get("due"), str):
            value["due"] = item["due"][:100]
        if isinstance(item.get("canComplete"), bool):
            value["canComplete"] = item["canComplete"]
        cleaned.append(value)
    output = {"items": cleaned}
    if result.get("nextCursor"):
        output["nextCursor"] = str(result["nextCursor"])[:8192]
    return output


@router.get("")
async def list_connections(request: Request):
    client = _identity(request)
    def read():
        with _db() as db:
            return {row[0] for row in db.execute("SELECT provider FROM connections WHERE client=?", (client,))}
    connected = await _call(read)
    return JSONResponse({"services": [{
        "id": provider, "connected": provider in connected,
        "auth": "oauth" if provider in OAUTH_SCOPES else "token",
        "oauthConfigured": bool(_oauth_config(provider)),
        "configured": provider in connected and provider in {"n8n", "zapier"},
    } for provider in sorted(PROVIDERS)]}, headers={"Cache-Control": "no-store"})


@router.put("/{provider}")
async def connect(provider: str, request: Request):
    client, adapter = _identity(request, True), _adapter(provider)
    body = await _body(request)
    creds = {"token": _text(body.get("token"), "access token", 8192)}
    for name in ("extra", "resource"):
        if body.get(name):
            creds[name] = _text(body[name], name)
    def validate_and_save():
        adapter.sources(provider, creds)
        _save(client, provider, creds)
    await _call(validate_and_save)
    return {"connected": True, "configured": provider in {"n8n", "zapier"}}


@router.delete("/{provider}")
async def disconnect(provider: str, request: Request):
    client = _identity(request, True)
    _adapter(provider)
    def remove():
        with _db() as db:
            db.execute("DELETE FROM connections WHERE client=? AND provider=?", (client, provider))
            db.execute("DELETE FROM oauth_states WHERE client=? AND provider=?", (client, provider))
    await _call(remove)
    return {"connected": False}


@router.get("/{provider}/sources")
async def list_sources(provider: str, request: Request):
    client, adapter = _identity(request), _adapter(provider)
    result = await _call(lambda: adapter.sources(provider, _credentials(client, provider)))
    sources = [{"id": str(row["id"])[:2048], "name": str(row.get("name") or "Untitled source")[:300]} for row in result]
    return JSONResponse({"sources": sources}, headers={"Cache-Control": "no-store"})


@router.get("/{provider}/items")
async def list_items(provider: str, request: Request, source: str = "", cursor: str | None = None):
    client, adapter = _identity(request), _adapter(provider)
    source = _text(source, "source")
    if cursor:
        cursor = _text(cursor, "page", 8192)
    result = await _call(lambda: adapter.items(provider, _credentials(client, provider), source, cursor))
    return JSONResponse(_clean_items(result), headers={"Cache-Control": "no-store"})


@router.patch("/{provider}/items/{item_id:path}")
async def complete_item(provider: str, item_id: str, request: Request):
    client, adapter = _identity(request, True), _adapter(provider)
    body = await _body(request)
    done, source = body.get("done"), _text(body.get("source"), "source")
    _text(item_id, "item")
    if type(done) is not bool:
        raise HTTPException(400, "Choose whether this task is done.")
    await _call(lambda: adapter.complete(provider, _credentials(client, provider), source, item_id, done))
    return {"done": done}


@router.post("/{provider}/send")
async def send_task(provider: str, request: Request):
    client = _identity(request, True)
    if provider not in {"n8n", "zapier"}:
        raise HTTPException(404, "This service doesn't accept task postcards.")
    body = await _body(request)
    payload = {"title": _text(body.get("title"), "task title", 2000), "done": body.get("done") is True}
    if body.get("url"):
        payload["url"] = _safe_url(body["url"])
        if not payload["url"]:
            raise HTTPException(400, "Use an HTTPS source link.")
    await _call(lambda: integration_local.send(provider, _credentials(client, provider), payload))
    return {"sent": True}


@router.post("/{provider}/oauth")
async def start_oauth(provider: str, request: Request):
    client = _identity(request, True)
    _adapter(provider)
    config = _oauth_config(provider)
    if not config:
        raise HTTPException(503, "OAuth needs this service's client ID and secret on the server. Use an access token or follow docs/INTEGRATIONS.md.")
    callback_host = urlsplit(config["redirect_uri"]).hostname
    origin = request.headers["origin"]
    local_hosts = {"localhost", "127.0.0.1", "::1"}
    if (request.url.hostname != callback_host
            or (callback_host in local_hosts and urlsplit(origin).hostname != callback_host)):
        raise HTTPException(400, "OAuth needs matching hostnames for your workspace, backend, and callback. Open the workspace and backend using localhost, or set LOFAI_OAUTH_REDIRECT_URI to the matching backend hostname and register that redirect with the provider.")
    state, verifier = secrets.token_urlsafe(32), secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    def save_state():
        with _db() as db:
            db.execute("DELETE FROM oauth_states WHERE expires < ? OR (client=? AND provider=?)", (time.time(), client, provider))
            db.execute("INSERT INTO oauth_states VALUES (?, ?, ?, ?, ?, ?)", (state, client, provider, origin, verifier, time.time() + 600))
    await _call(save_state)
    params = {"client_id": config["client_id"], "redirect_uri": config["redirect_uri"],
              "response_type": "code", "scope": config["scope"], "state": state,
              "code_challenge": challenge, "code_challenge_method": "S256"}
    if config["google"]:
        params.update(access_type="offline", prompt="consent")
    response = JSONResponse({"url": config["authorize"] + "?" + urlencode(params)}, headers={"Cache-Control": "no-store"})
    response.set_cookie("lofai_oauth_" + state[:16], state, max_age=600, httponly=True,
                        samesite="lax", secure=config["redirect_uri"].startswith("https:"), path=OAUTH_CALLBACK)
    return response


@router.get("/oauth/callback")
async def finish_oauth(request: Request, state: str = "", code: str = "", error: str = ""):
    _check_location(request)
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", state) or not secrets.compare_digest(
            request.cookies.get("lofai_oauth_" + state[:16], ""), state):
        raise HTTPException(400, "This connection window has expired. Start again from LofAI.")
    def exchange():
        with _db() as db:
            # Claim a state exactly once, while retaining a cancellable record
            # until token exchange finishes. Disconnect can cancel this flow.
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT client, provider, origin, verifier, expires FROM oauth_states WHERE state=?", (state,)).fetchone()
            if not row or row[4] < time.time():
                raise IntegrationError("This connection window has expired. Start again from LofAI.")
            db.execute("UPDATE oauth_states SET expires=0 WHERE state=?", (state,))
        client, provider, origin, verifier, _ = row
        if error or not code or len(code) > 4096:
            raise IntegrationError("Connection cancelled. You can close this window and settle back in.")
        config = _oauth_config(provider)
        if not config:
            raise IntegrationError("The server OAuth setup changed. Start again from LofAI.")
        data = _exchange(config, {"grant_type": "authorization_code", "code": code,
                                 "redirect_uri": config["redirect_uri"], "code_verifier": verifier})
        if not isinstance(data.get("access_token"), str):
            raise IntegrationError("This connection could not be completed. Try again from LofAI.")
        creds = {"token": data["access_token"], "expires_at": time.time() + int(data.get("expires_in", 3600))}
        if isinstance(data.get("refresh_token"), str):
            creds["refresh_token"] = data["refresh_token"]
        _adapter(provider).sources(provider, creds)
        with _db() as db:
            removed = db.execute("DELETE FROM oauth_states WHERE state=?", (state,)).rowcount
            if not removed:
                raise IntegrationError("This connection was cancelled. Start again from LofAI.")
            db.execute("INSERT OR REPLACE INTO connections VALUES (?, ?, ?)", (client, provider, json.dumps(creds)))
        return provider, origin
    nonce = secrets.token_urlsafe(18)
    script = ""
    try:
        provider, origin = await _call(exchange)
        message = "You're connected. This little window can rest now."
        event = json.dumps({"type": "lofai:integration-connected", "provider": provider}).replace("<", "\\u003c")
        target = json.dumps(origin).replace("<", "\\u003c")
        script = f'<script nonce="{nonce}">if(window.opener){{window.opener.postMessage({event},{target});window.close();}}</script>'
        status = 200
    except HTTPException as failure:
        message, status = str(failure.detail), failure.status_code
    response = HTMLResponse(
        '<!doctype html><html lang="en"><meta charset="utf-8"><title>LofAI connection</title>'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        f'<body><main><h1>LofAI</h1><p>{html.escape(message)}</p></main>{script}</body></html>',
        status_code=status, headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
                                    "Content-Security-Policy": f"default-src 'none'; script-src 'nonce-{nonce}'; base-uri 'none'; frame-ancestors 'none'"})
    response.delete_cookie("lofai_oauth_" + state[:16], path=OAUTH_CALLBACK)
    return response

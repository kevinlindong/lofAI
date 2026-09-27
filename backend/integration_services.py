"""Small, explicit adapters for project, inbox, and chat services.

Browsing and importing only read remote data. ``complete`` is the sole write
entrypoint; inbox and chat items deliberately cannot be changed remotely.
"""

from concurrent.futures import ThreadPoolExecutor
import html
import re
from urllib.parse import quote, unquote, urlencode, urlsplit

from integration_http import IntegrationError, request_json


PROVIDERS = {
    "notion", "linear", "github", "trello", "asana", "gmail",
    "outlook-mail", "slack", "discord",
}
PAGE_SIZE = 50
SOURCE_LIMIT = 1000
NOTION_HEADERS = {"Notion-Version": "2026-03-11"}
GITHUB_HEADERS = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2026-03-10",
}
GRAPH_ROOT = "https://graph.microsoft.com/v1.0"


def _object(value):
    if not isinstance(value, dict):
        raise IntegrationError("That service sent an unexpected response. Try again in a moment.", 502)
    return value


def _rows(value):
    if not isinstance(value, list) or any(not isinstance(row, dict) for row in value):
        raise IntegrationError("That service sent an unexpected list. Try again in a moment.", 502)
    return value


def _text(value, fallback="Untitled"):
    return (" ".join(str(value or "").split()) or fallback)[:500]


def _segment(value):
    value = str(value or "")
    if not value or len(value) > 1024 or value in {".", ".."} or any(ord(c) < 32 for c in value):
        raise IntegrationError("Choose a valid source or item first.")
    return quote(value, safe="")


def _credential(creds, name="token"):
    value = creds.get(name)
    if not isinstance(value, str) or not value.strip() or any(ord(c) < 32 or ord(c) > 126 for c in value):
        raise IntegrationError("Add the service credentials to connect.")
    return value.strip()


def _query(base, params):
    values = {key: value for key, value in params.items() if value is not None}
    return base + ("?" + urlencode(values) if values else "")


def _url(value):
    if not isinstance(value, str) or len(value) > 4096:
        return None
    try:
        parsed = urlsplit(value)
        if parsed.scheme == "https" and parsed.hostname and not parsed.username and not parsed.password:
            return value
    except ValueError:
        pass
    return None


def _item(identifier, title, done=False, kind="task", url=None, due=None, can_complete=True):
    result = {
        "id": str(identifier), "title": _text(title), "done": bool(done),
        "kind": kind, "canComplete": can_complete and kind == "task",
    }
    safe_url = _url(url)
    if safe_url:
        result["url"] = safe_url
    if due:
        result["due"] = str(due)[:100]
    return result


def _page(rows, cursor=None):
    result = {"items": rows}
    if cursor:
        result["nextCursor"] = str(cursor)
    return result


def _source(identifier, name):
    return {"id": str(identifier), "name": _text(name)}


def _collect_sources(fetch_page):
    """Follow source pages, with a clear error instead of silent truncation."""
    result, cursor, seen = [], None, set()
    for _ in range(20):
        rows, cursor = fetch_page(cursor)
        result.extend(rows)
        if len(result) > SOURCE_LIMIT:
            break
        if not cursor:
            return result
        if cursor in seen:
            raise IntegrationError("This service repeated a source page. Try connecting again in a moment.", 502)
        seen.add(cursor)
    raise IntegrationError("This account has too many sources to list at once. Narrow the token's access or choose a specific source when available.")


def _graph_url(base, cursor):
    if not cursor:
        return base
    parsed = urlsplit(cursor)
    if (parsed.scheme != "https" or parsed.netloc != "graph.microsoft.com"
            or unquote(parsed.path) != unquote(urlsplit(base).path) or parsed.fragment):
        raise IntegrationError("That Outlook page has expired. Choose the folder again.")
    return cursor


def _get(url, creds, headers=None):
    return request_json("GET", url, token=_credential(creds), headers=headers)


def _github_repo(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", value):
        raise IntegrationError("Use a GitHub repository in owner/repository format.")
    owner, repo = value.split("/")
    return f"{_segment(owner)}/{_segment(repo)}"


def _page_number(cursor):
    if cursor is None or cursor == "":
        return 1
    if not isinstance(cursor, str) or not cursor.isdigit() or not 1 <= int(cursor) <= 10000:
        raise IntegrationError("That page has expired. Start from the source again.")
    return int(cursor)


def _linear(creds, query, variables=None):
    token = _credential(creds)
    authorization = token if token.startswith("lin_api_") else f"Bearer {token}"
    result = _object(request_json(
        "POST", "https://api.linear.app/graphql",
        body={"query": query, "variables": variables or {}},
        headers={"Authorization": authorization},
    ))
    if result.get("errors"):
        raise IntegrationError("Linear couldn't finish that request. Check the key's access and try again.", 400)
    return _object(result.get("data"))


def _trello(creds, method, path, params=None, body=None):
    # Trello supports OAuth credentials in a header; keep secrets out of URLs.
    auth = 'OAuth oauth_consumer_key="{}", oauth_token="{}"'.format(
        quote(_credential(creds, "extra"), safe=""), quote(_credential(creds), safe=""),
    )
    return request_json(
        method, _query("https://api.trello.com/1/" + path, params or {}),
        body=body, headers={"Authorization": auth},
    )


def _slack(creds, method, params=None):
    result = _object(_get(_query("https://slack.com/api/" + method, params or {}), creds))
    if not result.get("ok"):
        code = result.get("error")
        message = {
            "invalid_auth": "Slack couldn't use that token. Add a fresh one to reconnect.",
            "token_revoked": "That Slack token was revoked. Add a fresh one to reconnect.",
            "missing_scope": "This Slack token needs channel read and history permissions.",
            "not_in_channel": "Invite your Slack app to this channel, then try again.",
            "channel_not_found": "Slack couldn't find that channel for this token.",
            "ratelimited": "Slack needs a little breather. Try again in a minute.",
        }.get(code, "Slack couldn't finish that request. Check your token and channel access.")
        raise IntegrationError(message, 429 if code == "ratelimited" else 400)
    return result


def _discord(creds, path, params=None):
    return request_json(
        "GET", _query("https://discord.com/api/v10/" + path, params or {}),
        headers={"Authorization": "Bot " + _credential(creds)},
    )


def _rich_text(parts):
    return "".join(str(part.get("plain_text") or part.get("text", {}).get("content", "")) for part in (parts or []))


def _notion_completion(properties):
    # Never guess which of several unrelated checkboxes represents completion.
    choices = [
        (name, value) for name, value in properties.items()
        if name.casefold() in {"done", "complete", "completed"} and value.get("type") == "checkbox"
    ]
    return choices[0] if len(choices) == 1 else None


def sources(provider, creds):
    """Validate credentials and collect up to 1,000 selectable sources."""
    if provider not in PROVIDERS:
        raise IntegrationError("That service isn't available yet.")
    _credential(creds)
    if provider == "notion":
        resource = creds.get("resource")
        if resource:
            row = _object(_get("https://api.notion.com/v1/data_sources/" + _segment(resource), creds, NOTION_HEADERS))
            return [_source(row["id"], _rich_text(row.get("title")) or "Shared data source")]
        def notion_page(cursor):
            body = {"filter": {"property": "object", "value": "data_source"}, "page_size": 100}
            if cursor:
                body["start_cursor"] = cursor
            data = _object(request_json(
                "POST", "https://api.notion.com/v1/search", token=_credential(creds),
                headers=NOTION_HEADERS, body=body,
            ))
            rows = [_source(row["id"], _rich_text(row.get("title")) or "Untitled data source") for row in _rows(data.get("results", []))]
            return rows, data.get("next_cursor") if data.get("has_more") else None
        return _collect_sources(notion_page)
    if provider == "linear":
        def linear_page(cursor):
            data = _linear(creds, "query($after: String) { teams(first: 100, after: $after) { nodes { id name } pageInfo { hasNextPage endCursor } } }", {"after": cursor})
            page = data["teams"].get("pageInfo", {})
            return ([_source(row["id"], row["name"]) for row in _rows(data["teams"]["nodes"])],
                    page.get("endCursor") if page.get("hasNextPage") else None)
        return _collect_sources(linear_page)
    if provider == "github":
        if creds.get("resource"):
            # A public repository can be read anonymously; verify the token too.
            _get("https://api.github.com/user", creds, GITHUB_HEADERS)
            row = _object(_get("https://api.github.com/repos/" + _github_repo(creds["resource"]), creds, GITHUB_HEADERS))
            return [_source(row["full_name"], row["full_name"])]
        def github_page(cursor):
            page = _page_number(cursor)
            rows = _rows(_get(_query("https://api.github.com/user/repos", {"per_page": 100, "sort": "updated", "page": page}), creds, GITHUB_HEADERS))
            return ([_source(row["full_name"], row["full_name"]) for row in rows if row.get("has_issues", True)],
                    str(page + 1) if len(rows) == 100 else None)
        return _collect_sources(github_page)
    if provider == "trello":
        rows = _rows(_trello(creds, "GET", "members/me/boards", {"filter": "open", "fields": "name"}))
        return _collect_sources(lambda _: ([_source(row["id"], row["name"]) for row in rows], None))
    if provider == "asana":
        def asana_page(cursor):
            data = _object(_get(_query("https://app.asana.com/api/1.0/projects", {
                "limit": 100, "archived": "false", "opt_fields": "name", "offset": cursor,
            }), creds))
            return ([_source(row["gid"], row["name"]) for row in _rows(data.get("data", []))],
                    (data.get("next_page") or {}).get("offset"))
        return _collect_sources(asana_page)
    if provider == "gmail":
        data = _object(_get("https://gmail.googleapis.com/gmail/v1/users/me/labels", creds))
        rows = _rows(data.get("labels", []))
        rows.sort(key=lambda row: (row.get("id") != "STARRED", row.get("id") != "INBOX", row.get("name", "")))
        return _collect_sources(lambda _: ([_source(row["id"], row["name"]) for row in rows], None))
    if provider == "outlook-mail":
        def outlook_page(cursor):
            base = GRAPH_ROOT + "/me/mailFolders?$top=100&$select=id,displayName"
            data = _object(_get(_graph_url(base, cursor), creds))
            return ([_source(row["id"], row["displayName"]) for row in _rows(data.get("value", []))], data.get("@odata.nextLink"))
        return _collect_sources(outlook_page)
    if provider == "slack":
        def slack_page(cursor):
            data = _slack(creds, "conversations.list", {"types": "public_channel,private_channel", "exclude_archived": "true", "limit": 200, "cursor": cursor})
            # A bot can only fetch history from channels it has joined.
            rows = _rows(data.get("channels", []))
            if _credential(creds).startswith("xoxb-"):
                rows = [row for row in rows if row.get("is_member")]
            return ([_source(row["id"], "#" + row["name"]) for row in rows],
                    (data.get("response_metadata") or {}).get("next_cursor"))
        return _collect_sources(slack_page)
    guild = creds.get("resource")
    if not isinstance(guild, str) or not guild.isdigit():
        raise IntegrationError("Add your Discord server ID to choose its channels.")
    rows = _rows(_discord(creds, "guilds/" + _segment(guild) + "/channels"))
    return _collect_sources(lambda _: ([_source(row["id"], "#" + row["name"]) for row in rows if row.get("type") in {0, 5}], None))


def items(provider, creds, source, cursor=None):
    """Read one bounded page. Cursors are opaque data, never arbitrary URLs."""
    if provider not in PROVIDERS:
        raise IntegrationError("That service isn't available yet.")
    if cursor is not None and (not isinstance(cursor, str) or len(cursor) > 8192):
        raise IntegrationError("That page has expired. Choose the source again.")
    source_path = _segment(source)
    if provider == "notion":
        body = {"page_size": PAGE_SIZE, "sorts": [{"timestamp": "last_edited_time", "direction": "descending"}]}
        if cursor:
            body["start_cursor"] = cursor
        data = _object(request_json(
            "POST", f"https://api.notion.com/v1/data_sources/{source_path}/query",
            token=_credential(creds), headers=NOTION_HEADERS, body=body,
        ))
        result = []
        for row in _rows(data.get("results", [])):
            if row.get("in_trash") or row.get("archived") or row.get("is_archived"):
                continue
            props = _object(row.get("properties", {}))
            title = next((_rich_text(prop.get("title")) for prop in props.values() if prop.get("type") == "title"), "Untitled page")
            completion = _notion_completion(props)
            due = next(((prop.get("date") or {}).get("start") for name, prop in props.items() if name.casefold() in {"due", "due date"} and prop.get("type") == "date"), None)
            result.append(_item(row["id"], title, completion[1].get("checkbox", False) if completion else False,
                                url=row.get("url"), due=due, can_complete=completion is not None))
        return _page(result, data.get("next_cursor") if data.get("has_more") else None)
    if provider == "linear":
        data = _linear(creds, """query($team: String!, $after: String) {
          team(id: $team) { issues(first: 50, after: $after, orderBy: updatedAt) {
            nodes { id title url dueDate state { type } }
            pageInfo { hasNextPage endCursor }
          } }
        }""", {"team": source, "after": cursor})
        connection = _object(_object(data.get("team")).get("issues"))
        result = [_item(row["id"], row["title"], (row.get("state") or {}).get("type") in {"completed", "canceled"},
                        url=row.get("url"), due=row.get("dueDate")) for row in _rows(connection.get("nodes", []))]
        page = connection.get("pageInfo", {})
        return _page(result, page.get("endCursor") if page.get("hasNextPage") else None)
    if provider == "github":
        page = _page_number(cursor)
        rows = _rows(_get(_query("https://api.github.com/repos/" + _github_repo(source) + "/issues", {
            "state": "all", "sort": "updated", "direction": "desc", "per_page": PAGE_SIZE, "page": page,
        }), creds, GITHUB_HEADERS))
        result = [_item(row["number"], row["title"], row.get("state") == "closed", url=row.get("html_url")) for row in rows if "pull_request" not in row]
        return _page(result, str(page + 1) if len(rows) == PAGE_SIZE else None)
    if provider == "trello":
        # Board card lists have no cursor contract; page the stable returned list locally.
        page = _page_number(cursor)
        rows = _rows(_trello(creds, "GET", f"boards/{source_path}/cards", {
            "filter": "open", "fields": "name,url,due,dueComplete",
        }))
        start = (page - 1) * PAGE_SIZE
        result = [_item(row["id"], row["name"], row.get("dueComplete", False), url=row.get("url"), due=row.get("due")) for row in rows[start:start + PAGE_SIZE]]
        return _page(result, str(page + 1) if start + PAGE_SIZE < len(rows) else None)
    if provider == "asana":
        data = _object(_get(_query(f"https://app.asana.com/api/1.0/projects/{source_path}/tasks", {
            "limit": PAGE_SIZE, "offset": cursor,
            "opt_fields": "name,completed,due_on,due_at,permalink_url",
        }), creds))
        result = [_item(row["gid"], row["name"], row.get("completed", False), url=row.get("permalink_url"),
                        due=row.get("due_at") or row.get("due_on")) for row in _rows(data.get("data", []))]
        return _page(result, (data.get("next_page") or {}).get("offset"))
    if provider == "gmail":
        data = _object(_get(_query("https://gmail.googleapis.com/gmail/v1/users/me/messages", {
            "labelIds": source, "maxResults": 15, "pageToken": cursor,
        }), creds))
        def read_message(row):
            message = _object(_get(_query("https://gmail.googleapis.com/gmail/v1/users/me/messages/" + _segment(row["id"]), {
                "format": "metadata", "metadataHeaders": "Subject",
            }), creds))
            headers = (message.get("payload") or {}).get("headers", [])
            subject = next((header.get("value") for header in headers if header.get("name", "").lower() == "subject"), "Email without a subject")
            thread_id = message.get("threadId") or row.get("threadId") or row["id"]
            return _item(row["id"], subject, kind="message", url="https://mail.google.com/mail/u/0/#all/" + _segment(thread_id))
        with ThreadPoolExecutor(max_workers=4) as pool:
            result = list(pool.map(read_message, _rows(data.get("messages", []))[:15]))
        return _page(result, data.get("nextPageToken"))
    if provider == "outlook-mail":
        base = GRAPH_ROOT + f"/me/mailFolders/{source_path}/messages"
        url = _query(base, {"$top": PAGE_SIZE, "$select": "id,subject,webLink", "$orderby": "receivedDateTime desc"})
        url = _graph_url(url, cursor)
        data = _object(_get(url, creds))
        return _page([_item(row["id"], row.get("subject") or "Email without a subject", kind="message", url=row.get("webLink"))
                      for row in _rows(data.get("value", []))], data.get("@odata.nextLink"))
    if provider == "slack":
        data = _slack(creds, "conversations.history", {"channel": source, "limit": 15, "cursor": cursor})
        rows = [row for row in _rows(data.get("messages", []))[:15]
                if row.get("subtype") not in {"channel_join", "channel_leave", "message_deleted"}]
        def read_slack_message(row):
            title = re.sub(r"<https?://[^|>]+\|([^>]+)>", r"\1", row.get("text") or "Shared a file")
            link = _slack(creds, "chat.getPermalink", {"channel": source, "message_ts": row["ts"]})
            return _item(row["ts"], html.unescape(title), kind="message", url=link.get("permalink"))
        with ThreadPoolExecutor(max_workers=4) as pool:
            result = list(pool.map(read_slack_message, rows))
        return _page(result, (data.get("response_metadata") or {}).get("next_cursor"))
    rows = _rows(_discord(creds, f"channels/{source_path}/messages", {"limit": PAGE_SIZE, "before": cursor}))
    result = []
    for row in rows:
        if row.get("type", 0) not in {0, 19}:
            continue
        title = row.get("content") or ("Shared an attachment" if row.get("attachments") else "")
        if not title:
            continue
        result.append(_item(row["id"], title, kind="message", url="https://discord.com/channels/" +
                            _segment(creds.get("resource")) + "/" + source_path + "/" + _segment(row["id"])))
    if rows and not result:
        raise IntegrationError("Discord returned no readable content. Enable Message Content intent for your bot.")
    return _page(result, rows[-1]["id"] if len(rows) == PAGE_SIZE else None)


def complete(provider, creds, source, item_id, done):
    """Change only completion, after the user has opted into remote sync."""
    if provider not in PROVIDERS:
        raise IntegrationError("That service isn't available yet.")
    if provider in {"gmail", "outlook-mail", "slack", "discord"}:
        raise IntegrationError("Messages become local tasks. Tick them off here; the original stays as it is.")
    if not isinstance(done, bool):
        raise IntegrationError("Choose whether the task is done.")
    item_path = _segment(item_id)
    if provider == "notion":
        page = _object(_get("https://api.notion.com/v1/pages/" + item_path, creds, NOTION_HEADERS))
        parent = page.get("parent", {})
        if str(parent.get("data_source_id", "")).replace("-", "") != str(source).replace("-", ""):
            raise IntegrationError("This Notion page has moved. Import it again from its current data source.")
        mapping = _notion_completion(_object(page.get("properties", {})))
        if not mapping:
            raise IntegrationError("For Notion sync, add one checkbox property named Done, Complete, or Completed.")
        request_json("PATCH", "https://api.notion.com/v1/pages/" + item_path, token=_credential(creds), headers=NOTION_HEADERS,
                     body={"properties": {mapping[0]: {"checkbox": done}}})
        return
    if provider == "linear":
        data = _linear(creds, """query($id: String!) {
          issue(id: $id) { team { id states(first: 100) { nodes { id type position } } } }
        }""", {"id": item_id})
        team = _object(_object(data.get("issue")).get("team"))
        if team.get("id") != source:
            raise IntegrationError("This Linear issue has moved teams. Import it from its current team.")
        desired = "completed" if done else "unstarted"
        states = [state for state in _rows(team["states"]["nodes"]) if state.get("type") == desired]
        if not states:
            raise IntegrationError(f"This Linear team needs a {desired} workflow state to sync completion.")
        state = min(states, key=lambda row: row.get("position", 0))
        result = _linear(creds, """mutation($id: String!, $state: String!) {
          issueUpdate(id: $id, input: {stateId: $state}) { success }
        }""", {"id": item_id, "state": state["id"]})
        if not _object(result.get("issueUpdate")).get("success"):
            raise IntegrationError("Linear didn't save that checkmark. Try again in a moment.", 502)
        return
    if provider == "github":
        if not str(item_id).isdigit():
            raise IntegrationError("Choose a valid GitHub issue.")
        request_json("PATCH", "https://api.github.com/repos/" + _github_repo(source) + "/issues/" + item_path,
                     token=_credential(creds), headers=GITHUB_HEADERS, body={"state": "closed" if done else "open"})
        return
    if provider == "trello":
        card = _object(_trello(creds, "GET", f"cards/{item_path}", {"fields": "idBoard"}))
        if card.get("idBoard") != source:
            raise IntegrationError("This Trello card moved boards. Import it from its current board.")
        _trello(creds, "PUT", f"cards/{item_path}", body={"dueComplete": done})
        return
    task = _object(_get(f"https://app.asana.com/api/1.0/tasks/{item_path}?opt_fields=memberships.project.gid", creds))
    memberships = _rows(_object(task.get("data")).get("memberships", []))
    if source not in {(row.get("project") or {}).get("gid") for row in memberships}:
        raise IntegrationError("This Asana task moved projects. Import it from its current project.")
    request_json("PUT", f"https://app.asana.com/api/1.0/tasks/{item_path}", token=_credential(creds), body={"data": {"completed": done}})

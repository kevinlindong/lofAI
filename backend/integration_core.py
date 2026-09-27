"""Google Tasks/Calendar, Todoist, and Microsoft To Do/Calendar adapters."""

from datetime import datetime, timedelta, timezone
from urllib.parse import quote, urlencode, urlsplit

from integration_http import IntegrationError, request_json

PROVIDERS = {"google-tasks", "google-calendar", "todoist", "microsoft-todo", "outlook-calendar"}
GOOGLE_TASKS = "https://tasks.googleapis.com/tasks/v1"
GOOGLE_CALENDAR = "https://www.googleapis.com/calendar/v3"
TODOIST = "https://api.todoist.com/api/v1"
GRAPH = "https://graph.microsoft.com/v1.0"


def _id(value):
    if not isinstance(value, str) or not value or len(value) > 2048 or any(ord(c) < 32 for c in value):
        raise IntegrationError("Choose a valid source or item first.")
    if value in {".", ".."}:
        raise IntegrationError("Choose a valid source or item first.")
    return quote(value, safe="")


def _url(base, params):
    return base + "?" + urlencode({key: value for key, value in params.items() if value is not None})


def _graph_page(base, cursor):
    # Graph returns absolute nextLink URLs. Accept only the same collection;
    # callers cannot turn pagination into an arbitrary authenticated request.
    if cursor:
        original, next_url = urlsplit(base), urlsplit(cursor)
        if (next_url.scheme != original.scheme or next_url.netloc != original.netloc
                or next_url.path != original.path or next_url.fragment):
            raise IntegrationError("That page has wandered off. Refresh this source.")
        return cursor
    return base


def _collect(base, token, key, next_key, parameter=None, headers=None):
    result, cursor = [], None
    for _ in range(20):
        if parameter:
            url = base + ("&" if "?" in base else "?") + urlencode({parameter: cursor}) if cursor else base
        else:
            url = _graph_page(base, cursor)
        data = request_json("GET", url, token, headers=headers)
        result.extend(data.get(key, []))
        cursor = data.get(next_key)
        if not cursor:
            return result
    raise IntegrationError("This account has too many sources to show at once. Try a connection with fewer shared sources.")


def sources(provider, creds):
    token = creds["token"]
    if provider == "google-tasks":
        rows = _collect(GOOGLE_TASKS + "/users/@me/lists?maxResults=100", token, "items", "nextPageToken", "pageToken")
        return [{"id": row["id"], "name": row.get("title") or "Untitled list"} for row in rows]
    if provider == "google-calendar":
        rows = _collect(GOOGLE_CALENDAR + "/users/me/calendarList?maxResults=250", token, "items", "nextPageToken", "pageToken")
        return [{"id": row["id"], "name": row.get("summary") or "Calendar"} for row in rows]
    if provider == "todoist":
        rows = _collect(TODOIST + "/projects?limit=200", token, "results", "next_cursor", "cursor")
        return [{"id": str(row["id"]), "name": row.get("name") or "Project"} for row in rows]
    if provider in {"microsoft-todo", "outlook-calendar"}:
        path = "/me/todo/lists" if provider == "microsoft-todo" else "/me/calendars"
        rows = _collect(GRAPH + path + "?$top=100", token, "value", "@odata.nextLink")
        return [{"id": row["id"], "name": row.get("displayName") or row.get("name") or "List"} for row in rows]
    raise IntegrationError("This service is not supported.", 404)


def _item(row, title, done=False, kind="task", url=None, due=None):
    result = {"id": str(row["id"]), "title": title or "A little untitled thing", "done": done, "kind": kind, "canComplete": kind == "task"}
    if url:
        result["url"] = url
    if due:
        result["due"] = due
    return result


def _utc_date(value):
    if not value:
        return None
    date = value.get("dateTime")
    # Graph requests explicitly use UTC. Its dateTime string omits the zone.
    if date and value.get("timeZone") in {"UTC", "Etc/UTC"} and not date.endswith("Z"):
        date += "Z"
    return date


def items(provider, creds, source, cursor=None):
    source_id, token = _id(source), creds["token"]
    if provider == "google-tasks":
        data = request_json("GET", _url(f"{GOOGLE_TASKS}/lists/{source_id}/tasks", {
            "maxResults": 100, "showCompleted": "true", "showHidden": "true", "pageToken": cursor,
        }), token)
        # Google carries date-only deadlines as midnight UTC. Preserve the
        # calendar day instead of shifting it when the browser localizes it.
        result = [_item(row, row.get("title"), row.get("status") == "completed",
                        url=row.get("webViewLink"), due=(row.get("due") or "")[:10])
                  for row in data.get("items", []) if not row.get("deleted")]
        return {"items": result, "nextCursor": data.get("nextPageToken")}
    if provider == "google-calendar":
        now = datetime.now(timezone.utc)
        data = request_json("GET", _url(f"{GOOGLE_CALENDAR}/calendars/{source_id}/events", {
            "maxResults": 100, "singleEvents": "true", "orderBy": "startTime",
            "timeMin": now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat(),
            "timeMax": (now + timedelta(days=14)).replace(hour=0, minute=0, second=0, microsecond=0).isoformat(),
            "pageToken": cursor,
        }), token)
        result = [_item(row, row.get("summary"), kind="event", url=row.get("htmlLink"),
                        due=row.get("start", {}).get("dateTime") or row.get("start", {}).get("date"))
                  for row in data.get("items", []) if row.get("status") != "cancelled"]
        return {"items": result, "nextCursor": data.get("nextPageToken")}
    if provider == "todoist":
        data = request_json("GET", _url(TODOIST + "/tasks", {"project_id": source, "limit": 100, "cursor": cursor}), token)
        result = [_item(row, row.get("content"), bool(row.get("checked", row.get("is_completed", False))),
                        url=row.get("url") or f"https://app.todoist.com/app/task/{_id(str(row['id']))}",
                        due=(row.get("due") or {}).get("datetime") or (row.get("due") or {}).get("date"))
                  for row in data.get("results", [])]
        return {"items": result, "nextCursor": data.get("next_cursor")}
    if provider == "microsoft-todo":
        base = f"{GRAPH}/me/todo/lists/{source_id}/tasks?$top=100"
        data = request_json("GET", _graph_page(base, cursor), token, headers={"Prefer": 'outlook.timezone="UTC"'})
        return {"items": [_item(row, row.get("title"), row.get("status") == "completed",
                                url="https://to-do.office.com/tasks/", due=_utc_date(row.get("dueDateTime")))
                          for row in data.get("value", [])], "nextCursor": data.get("@odata.nextLink")}
    if provider == "outlook-calendar":
        now = datetime.now(timezone.utc)
        base = _url(f"{GRAPH}/me/calendars/{source_id}/calendarView", {
            "startDateTime": now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat(),
            "endDateTime": (now + timedelta(days=14)).replace(hour=0, minute=0, second=0, microsecond=0).isoformat(),
            "$top": 100, "$orderby": "start/dateTime",
            "$select": "id,subject,start,webLink,isCancelled",
        })
        data = request_json("GET", _graph_page(base, cursor), token, headers={"Prefer": 'outlook.timezone="UTC"'})
        return {"items": [_item(row, row.get("subject"), kind="event", url=row.get("webLink"), due=_utc_date(row.get("start")))
                          for row in data.get("value", []) if not row.get("isCancelled")],
                "nextCursor": data.get("@odata.nextLink")}
    raise IntegrationError("This service is not supported.", 404)


def complete(provider, creds, source, item_id, done):
    source_id, task_id, token = _id(source), _id(item_id), creds["token"]
    if provider == "google-tasks":
        body = {"status": "completed" if done else "needsAction"}
        if not done:
            body["completed"] = None
        request_json("PATCH", f"{GOOGLE_TASKS}/lists/{source_id}/tasks/{task_id}", token, body)
    elif provider == "todoist":
        request_json("POST", f"{TODOIST}/tasks/{task_id}/{'close' if done else 'reopen'}", token)
    elif provider == "microsoft-todo":
        request_json("PATCH", f"{GRAPH}/me/todo/lists/{source_id}/tasks/{task_id}", token,
                     {"status": "completed" if done else "notStarted"})
    else:
        raise IntegrationError("Calendar events are brought in as local reminders; they are not changed here.")

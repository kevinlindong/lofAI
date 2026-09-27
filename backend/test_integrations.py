"""Connection isolation, safe routing, OAuth binding, and core provider behavior.

All provider calls are mocked; these tests never read or mutate real accounts.
"""

import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import httpx
from fastapi import FastAPI

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import integration_core as core
import integration_http as remote
import integrations


class IntegrationRoutes(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.environment = patch.dict(os.environ, {
            "LOFAI_INTEGRATIONS_DIR": self.directory.name,
            "LOFAI_ALLOWED_ORIGINS": "http://localhost:3000",
            "LOFAI_INTEGRATIONS_ALLOW_REMOTE": "0",
        })
        self.environment.start()
        app = FastAPI()
        app.include_router(integrations.router)
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, client=("127.0.0.1", 12345)),
            base_url="http://localhost:8000",
            headers={"Origin": "http://localhost:3000", "X-Lofai-Client": "a" * 48},
        )

    async def asyncTearDown(self):
        await self.client.aclose()
        self.environment.stop()
        self.directory.cleanup()

    async def test_validated_connections_are_isolated_and_secrets_never_returned(self):
        with patch.object(core, "sources", return_value=[{"id": "one", "name": "My list"}]):
            response = await self.client.put("/integrations/todoist", json={"token": "top-secret"})
        self.assertEqual(response.status_code, 200)
        response = await self.client.get("/integrations")
        self.assertNotIn("top-secret", response.text)
        mine = {row["id"]: row for row in response.json()["services"]}
        self.assertTrue(mine["todoist"]["connected"])
        other = await self.client.get("/integrations", headers={"X-Lofai-Client": "b" * 48})
        self.assertFalse(any(row["connected"] for row in other.json()["services"]))
        denied = await self.client.get("/integrations/todoist/sources", headers={"X-Lofai-Client": "b" * 48})
        self.assertEqual(denied.status_code, 401)
        self.assertEqual((Path(self.directory.name) / "integrations.sqlite3").stat().st_mode & 0o777, 0o600)
        self.assertEqual((await self.client.delete("/integrations/todoist")).status_code, 200)
        self.assertEqual((await self.client.get("/integrations/todoist/sources")).status_code, 401)

    async def test_failed_validation_does_not_save_connection(self):
        with patch.object(core, "sources", side_effect=remote.IntegrationError("Expired", 401)):
            response = await self.client.put("/integrations/todoist", json={"token": "bad"})
        self.assertEqual(response.status_code, 401)
        self.assertFalse(any(row["connected"] for row in (await self.client.get("/integrations")).json()["services"]))

    async def test_mutations_require_exact_origin_and_bounded_json(self):
        with patch.object(core, "sources") as fetch:
            response = await self.client.put("/integrations/todoist", json={"token": "secret"}, headers={"Origin": "https://evil.example"})
            self.assertEqual(response.status_code, 403)
            self.client.headers.pop("Origin")
            response = await self.client.put("/integrations/todoist", json={"token": "secret"})
            self.assertEqual(response.status_code, 403)
            self.client.headers["Origin"] = "http://localhost:3000"
            response = await self.client.put("/integrations/todoist", json={"token": "x" * 17000})
            self.assertEqual(response.status_code, 413)
            response = await self.client.put("/integrations/todoist", json={"token": {"secret": "don't echo me"}})
            self.assertEqual(response.status_code, 400)
            self.assertNotIn("don't echo", response.text)
            fetch.assert_not_called()

    async def test_unknown_provider_and_missing_browser_secret_are_rejected(self):
        self.assertEqual((await self.client.put("/integrations/example.com", json={"token": "secret"})).status_code, 404)
        self.assertEqual((await self.client.get("/integrations", headers={"X-Lofai-Client": ""})).status_code, 401)

    async def test_remote_address_rejected_by_default_even_with_a_valid_origin(self):
        from starlette.requests import Request
        incoming = Request({"type": "http", "method": "GET", "path": "/", "headers": [], "client": ("192.168.1.5", 1)})
        with self.assertRaises(Exception) as rejected:
            integrations._check_location(incoming)
        self.assertEqual(rejected.exception.status_code, 403)

    async def test_items_are_sanitized_and_completion_waits_for_remote_success(self):
        with patch.object(core, "sources", return_value=[]):
            await self.client.put("/integrations/todoist", json={"token": "secret"})
        with patch.object(core, "items", return_value={"items": [{"id": "1", "title": "hello", "done": False,
                                                                   "url": "javascript:alert(1)", "token": "secret"}]}):
            response = await self.client.get("/integrations/todoist/items?source=one")
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("url", response.json()["items"][0])
        self.assertNotIn("secret", response.text)
        with patch.object(core, "complete", side_effect=remote.IntegrationError("Need permission", 403)):
            response = await self.client.patch("/integrations/todoist/items/1", json={"done": True, "source": "one"})
        self.assertEqual(response.status_code, 403)

    async def test_oauth_callback_requires_cookie_and_one_time_state_then_saves(self):
        env = {"LOFAI_GOOGLE_CLIENT_ID": "client", "LOFAI_GOOGLE_CLIENT_SECRET": "secret",
               "LOFAI_OAUTH_REDIRECT_URI": "http://localhost:8000/integrations/oauth/callback"}
        with patch.dict(os.environ, env):
            response = await self.client.post("/integrations/google-tasks/oauth")
            self.assertEqual(response.status_code, 200)
            query = parse_qs(urlsplit(response.json()["url"]).query)
            self.assertEqual(query["code_challenge_method"], ["S256"])
            state = query["state"][0]
            saved_cookies = dict(self.client.cookies)
            self.client.cookies.clear()
            response = await self.client.get("/integrations/oauth/callback", params={"state": state, "code": "code"})
            self.assertEqual(response.status_code, 400)
            self.client.cookies.update(saved_cookies)
            with patch.object(integrations, "_exchange", return_value={"access_token": "private", "refresh_token": "refresh", "expires_in": 3600}), patch.object(core, "sources", return_value=[]):
                response = await self.client.get("/integrations/oauth/callback", params={"state": state, "code": "code"})
            self.assertEqual(response.status_code, 200)
            self.assertIn("lofai:integration-connected", response.text)
            self.assertNotIn("private", response.text)
            self.client.cookies.update(saved_cookies)
            replay = await self.client.get("/integrations/oauth/callback", params={"state": state, "code": "code"})
            self.assertEqual(replay.status_code, 400)
            rows = (await self.client.get("/integrations")).json()["services"]
            self.assertTrue(next(row for row in rows if row["id"] == "google-tasks")["connected"])

    async def test_oauth_rejects_mismatched_hostname_before_creating_state(self):
        env = {"LOFAI_GOOGLE_CLIENT_ID": "client", "LOFAI_GOOGLE_CLIENT_SECRET": "secret",
               "LOFAI_OAUTH_REDIRECT_URI": "http://localhost:8000/integrations/oauth/callback",
               "LOFAI_ALLOWED_ORIGINS": "http://localhost:3000,http://127.0.0.1:3000"}
        with patch.dict(os.environ, env):
            response = await self.client.post("http://127.0.0.1:8000/integrations/google-tasks/oauth")
            self.assertEqual(response.status_code, 400)
            self.assertIn("LOFAI_OAUTH_REDIRECT_URI", response.json()["detail"])
            self.assertNotIn("set-cookie", response.headers)
            # A different frontend loopback host would also prevent its cookie
            # from being set, even when backend and callback already match.
            response = await self.client.post("/integrations/google-tasks/oauth", headers={"Origin": "http://127.0.0.1:3000"})
            self.assertEqual(response.status_code, 400)
            with integrations._db() as db:
                self.assertEqual(db.execute("SELECT count(*) FROM oauth_states").fetchone()[0], 0)
            # A consistently configured 127.0.0.1 flow remains available.
            os.environ["LOFAI_OAUTH_REDIRECT_URI"] = "http://127.0.0.1:8000/integrations/oauth/callback"
            response = await self.client.post("http://127.0.0.1:8000/integrations/google-tasks/oauth", headers={"Origin": "http://127.0.0.1:3000"})
            self.assertEqual(response.status_code, 200)

    async def test_native_item_id_with_slashes_reaches_adapter_without_changing_id(self):
        import integration_local
        with patch.object(integration_local, "sources", return_value=[]):
            await self.client.put("/integrations/apple-reminders", json={"token": "native"})
        with patch.object(integration_local, "complete") as complete:
            response = await self.client.patch("/integrations/apple-reminders/items/x-apple-reminder%3A%2F%2Fitem-id", json={"source": "list", "done": True})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(complete.call_args.args[3], "x-apple-reminder://item-id")

    async def test_refresh_does_not_resurrect_a_disconnected_account(self):
        client = "workspace-hash"
        integrations._save(client, "google-tasks", {"token": "old", "refresh_token": "refresh", "expires_at": 0})
        def exchange(*args):
            with integrations._db() as db:
                db.execute("DELETE FROM connections WHERE client=?", (client,))
            return {"access_token": "new", "expires_in": 3600}
        with patch.object(integrations, "_oauth_config", return_value={"configured": True}), patch.object(integrations, "_exchange", side_effect=exchange):
            with self.assertRaises(remote.IntegrationError):
                integrations._credentials(client, "google-tasks")
        with self.assertRaises(remote.IntegrationError):
            integrations._load(client, "google-tasks")


class ProviderBehavior(unittest.TestCase):
    def test_google_tasks_pagination_and_reopening(self):
        with patch.object(core, "request_json", return_value={"items": [{"id": "1", "title": "Tea", "status": "completed", "due": "2026-09-26T00:00:00.000Z"}], "nextPageToken": "next"}) as fetch:
            result = core.items("google-tasks", {"token": "secret"}, "list/one", "page")
            self.assertTrue(result["items"][0]["done"])
            self.assertEqual(result["nextCursor"], "next")
            self.assertEqual(result["items"][0]["due"], "2026-09-26")
            self.assertIn("list%2Fone", fetch.call_args.args[1])
            query = parse_qs(urlsplit(fetch.call_args.args[1]).query)
            self.assertEqual(query["showHidden"], ["true"])
            self.assertEqual(query["pageToken"], ["page"])
            core.complete("google-tasks", {"token": "secret"}, "list", "1", False)
            self.assertEqual(fetch.call_args.args[3], {"status": "needsAction", "completed": None})

    def test_source_pagination_collects_all_pages(self):
        with patch.object(core, "request_json", side_effect=[{"results": [{"id": "1", "name": "one"}], "next_cursor": "more"},
                                                             {"results": [{"id": "2", "name": "two"}]}]) as fetch:
            rows = core.sources("todoist", {"token": "secret"})
        self.assertEqual([row["id"] for row in rows], ["1", "2"])
        self.assertIn("cursor=more", fetch.call_args.args[1])

    def test_graph_cursor_cannot_change_host_or_resource(self):
        with patch.object(core, "request_json") as fetch:
            for cursor in ("https://evil.example/", "https://graph.microsoft.com/v1.0/me/messages", "http://graph.microsoft.com/v1.0/me/todo/lists/list/tasks"):
                with self.assertRaises(remote.IntegrationError):
                    core.items("microsoft-todo", {"token": "secret"}, "list", cursor)
            fetch.assert_not_called()

    def test_calendar_expands_recurring_instances_and_keeps_timezone(self):
        with patch.object(core, "request_json", return_value={"items": [{"id": "1", "summary": "Tea", "start": {"dateTime": "2026-09-26T14:00:00-07:00"}}]}) as fetch:
            result = core.items("google-calendar", {"token": "secret"}, "primary")
            query = parse_qs(urlsplit(fetch.call_args.args[1]).query)
            self.assertEqual(query["singleEvents"], ["true"])
            self.assertEqual(result["items"][0]["due"], "2026-09-26T14:00:00-07:00")
            self.assertFalse(result["items"][0]["canComplete"])
        with patch.object(core, "request_json", return_value={"value": [{"id": "1", "subject": "Tea", "start": {"dateTime": "2026-09-26T21:00:00", "timeZone": "UTC"}}]}) as fetch:
            result = core.items("outlook-calendar", {"token": "secret"}, "one")
            self.assertIn("/calendarView?", fetch.call_args.args[1])
            self.assertTrue(result["items"][0]["due"].endswith("Z"))

    def test_http_rejects_unlisted_hosts_and_redirects(self):
        with patch.object(remote, "build_opener") as open_request:
            for url in ("http://api.todoist.com/api/v1/tasks", "https://api.todoist.com.evil.example/", "https://api.todoist.com:444/", "https://user@api.todoist.com/"):
                with self.assertRaises(remote.IntegrationError):
                    remote.request_json("GET", url, "secret")
            open_request.assert_not_called()
        self.assertIsNone(remote._NoRedirect().redirect_request(None, None, 302, "", {}, "https://evil.example"))


if __name__ == "__main__":
    unittest.main()

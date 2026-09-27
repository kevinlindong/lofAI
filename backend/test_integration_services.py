"""Provider contract tests. No real accounts or network calls are used."""

import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import integration_services as services
from integration_http import IntegrationError


class ServiceAdapterTests(unittest.TestCase):
    def setUp(self):
        self.creds = {"token": "test-token"}

    @patch("integration_services.request_json")
    def test_every_provider_authenticates_when_listing_sources(self, request):
        fixtures = {
            "notion": ({"results": []}, {}),
            "linear": ({"data": {"teams": {"nodes": []}}}, {}),
            "github": ([], {}),
            "trello": ([], {"extra": "test-key"}),
            "asana": ({"data": []}, {}),
            "gmail": ({"labels": []}, {}),
            "outlook-mail": ({"value": []}, {}),
            "slack": ({"ok": True, "channels": []}, {}),
            "discord": ([], {"resource": "123456"}),
        }
        for provider, (response, extra) in fixtures.items():
            with self.subTest(provider=provider):
                request.reset_mock()
                request.return_value = response
                self.assertEqual(services.sources(provider, {**self.creds, **extra}), [])
                request.assert_called_once()
                args, kwargs = request.call_args
                self.assertTrue(args[1].startswith("https://"))
                self.assertNotIn("test-token", args[1])
                self.assertTrue(kwargs.get("token") or kwargs.get("headers", {}).get("Authorization"))

    @patch("integration_services.request_json")
    def test_invalid_slack_and_linear_credentials_cannot_look_connected(self, request):
        for provider, response in [
            ("slack", {"ok": False, "error": "invalid_auth"}),
            ("linear", {"errors": [{"message": "authentication failed"}], "data": {"teams": {"nodes": []}}}),
        ]:
            with self.subTest(provider=provider):
                request.return_value = response
                with self.assertRaises(IntegrationError):
                    services.sources(provider, self.creds)

    @patch("integration_services.request_json")
    def test_slack_source_discovery_reaches_joined_channel_after_filtered_page(self, request):
        request.side_effect = [
            {"ok": True, "channels": [{"id": "C1", "name": "elsewhere", "is_member": False}],
             "response_metadata": {"next_cursor": "page+two"}},
            {"ok": True, "channels": [{"id": "C2", "name": "our-room", "is_member": True}]},
        ]
        result = services.sources("slack", {"token": "xoxb-test-token"})
        self.assertEqual(result, [{"id": "C2", "name": "#our-room"}])
        self.assertEqual(request.call_count, 2)
        query = parse_qs(urlsplit(request.call_args.args[1]).query)
        self.assertEqual(query["cursor"], ["page+two"])

    @patch("integration_services.request_json")
    def test_notion_source_discovery_collects_pages_and_rejects_repeated_cursor(self, request):
        first = {"results": [{"id": "one", "title": [{"plain_text": "One"}]}],
                 "has_more": True, "next_cursor": "next"}
        request.side_effect = [first, {"results": [{"id": "two", "title": [{"plain_text": "Two"}]}],
                                      "has_more": False}]
        self.assertEqual(services.sources("notion", self.creds),
                         [{"id": "one", "name": "One"}, {"id": "two", "name": "Two"}])
        self.assertEqual(request.call_args.kwargs["body"]["start_cursor"], "next")
        request.reset_mock()
        request.side_effect = [first, first]
        with self.assertRaisesRegex(IntegrationError, "repeated a source page"):
            services.sources("notion", self.creds)
        self.assertEqual(request.call_count, 2)

    @patch("integration_services.request_json")
    def test_outlook_source_pagination_blocks_foreign_or_different_collection(self, request):
        for cursor in [
            "https://evil.example/v1.0/me/mailFolders?$skip=100",
            "https://graph.microsoft.com/v1.0/me/messages?$skip=100",
        ]:
            with self.subTest(cursor=cursor):
                request.reset_mock()
                request.return_value = {"value": [{"id": "inbox", "displayName": "Inbox"}],
                                        "@odata.nextLink": cursor}
                with self.assertRaises(IntegrationError):
                    services.sources("outlook-mail", self.creds)
                request.assert_called_once()
                self.assertTrue(request.call_args.args[1].startswith(
                    "https://graph.microsoft.com/v1.0/me/mailFolders?"))

    @patch("integration_services.request_json")
    def test_linear_personal_key_uses_raw_authorization(self, request):
        request.return_value = {"data": {"teams": {"nodes": []}}}
        services.sources("linear", {"token": "lin_api_testing"})
        self.assertEqual(request.call_args.kwargs["headers"]["Authorization"], "lin_api_testing")

    @patch("integration_services.request_json")
    def test_github_explicit_repo_validates_token_before_public_repo(self, request):
        request.side_effect = [{"login": "someone"}, {"full_name": "someone/repo"}]
        self.assertEqual(services.sources("github", {**self.creds, "resource": "someone/repo"}),
                         [{"id": "someone/repo", "name": "someone/repo"}])
        self.assertEqual(request.call_args_list[0].args[1], "https://api.github.com/user")

    @patch("integration_services.request_json")
    def test_github_import_excludes_pull_requests_and_paginates_unfiltered_rows(self, request):
        rows = [{"number": number, "title": f"PR {number}", "pull_request": {}} for number in range(49)]
        rows.append({"number": 50, "title": "Issue", "state": "closed", "html_url": "https://github.com/o/r/issues/50"})
        request.return_value = rows
        result = services.items("github", self.creds, "o/r")
        self.assertEqual(len(result["items"]), 1)
        self.assertTrue(result["items"][0]["done"])
        self.assertEqual(result["nextCursor"], "2")

    @patch("integration_services.request_json")
    def test_outlook_cursor_cannot_redirect_credentials(self, request):
        for cursor in [
            "https://evil.example/v1.0/me/mailFolders/inbox/messages",
            "https://graph.microsoft.com.evil.example/v1.0/me/mailFolders/inbox/messages",
            "https://graph.microsoft.com/v1.0/users/someone/messages",
            "http://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages",
            "https://graph.microsoft.com/v1.0/me/mailFolders/other/messages",
        ]:
            with self.subTest(cursor=cursor), self.assertRaises(IntegrationError):
                services.items("outlook-mail", self.creds, "inbox", cursor)
        request.assert_not_called()

    @patch("integration_services.request_json")
    def test_outlook_preserves_exact_next_link(self, request):
        cursor = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=57&$top=50"
        request.return_value = {"value": [{"id": "message", "subject": "Hello", "webLink": "https://outlook.office.com/mail/message"}]}
        result = services.items("outlook-mail", self.creds, "inbox", cursor)
        self.assertEqual(request.call_args.args[1], cursor)
        self.assertEqual(result["items"][0]["kind"], "message")
        self.assertFalse(result["items"][0]["canComplete"])

    @patch("integration_services.request_json")
    def test_readonly_services_cannot_mutate_messages(self, request):
        for provider in {"gmail", "outlook-mail", "slack", "discord"}:
            with self.subTest(provider=provider), self.assertRaises(IntegrationError):
                services.complete(provider, self.creds, "source", "item", True)
        request.assert_not_called()

    @patch("integration_services.request_json")
    def test_trello_credentials_stay_in_header_and_completion_never_archives(self, request):
        request.side_effect = [{"idBoard": "board"}, {}]
        services.complete("trello", {**self.creds, "extra": "app-key"}, "board", "card", True)
        args, kwargs = request.call_args
        self.assertEqual(args, ("PUT", "https://api.trello.com/1/cards/card"))
        self.assertEqual(kwargs["body"], {"dueComplete": True})
        self.assertIn('oauth_token="test-token"', kwargs["headers"]["Authorization"])
        self.assertNotIn("test-token", args[1])

    @patch("integration_services.request_json")
    def test_trello_rejects_moved_card_before_write(self, request):
        request.return_value = {"idBoard": "other-board"}
        with self.assertRaises(IntegrationError):
            services.complete("trello", {**self.creds, "extra": "key"}, "board", "card", True)
        request.assert_called_once()
        self.assertEqual(request.call_args.args[0], "GET")

    @patch("integration_services.request_json")
    def test_asana_preserves_api_pagination_and_due_date(self, request):
        request.return_value = {"data": [{"gid": "task", "name": "Write", "completed": False, "due_on": "2026-10-01"}],
                                "next_page": {"offset": "opaque+next"}}
        result = services.items("asana", self.creds, "project", "opaque+current")
        self.assertEqual(result["nextCursor"], "opaque+next")
        self.assertEqual(result["items"][0]["due"], "2026-10-01")
        self.assertEqual(parse_qs(urlsplit(request.call_args.args[1]).query)["offset"], ["opaque+current"])

    @patch("integration_services.request_json")
    def test_asana_rejects_moved_task_before_write(self, request):
        request.return_value = {"data": {"memberships": [{"project": {"gid": "elsewhere"}}]}}
        with self.assertRaises(IntegrationError):
            services.complete("asana", self.creds, "project", "task", True)
        request.assert_called_once()

    @patch("integration_services.request_json")
    def test_linear_unsuccessful_mutation_is_not_reported_saved(self, request):
        request.side_effect = [
            {"data": {"issue": {"team": {"id": "team", "states": {"nodes": [{"id": "done", "type": "completed", "position": 1}]}}}}},
            {"data": {"issueUpdate": {"success": False}}},
        ]
        with self.assertRaises(IntegrationError):
            services.complete("linear", self.creds, "team", "issue", True)

    @patch("integration_services.request_json")
    def test_notion_uses_title_and_only_known_completion_checkbox(self, request):
        request.return_value = {"results": [{"id": "page", "properties": {
            "Name": {"type": "title", "title": [{"plain_text": "Write "}, {"plain_text": "a poem"}]},
            "Approved": {"type": "checkbox", "checkbox": True},
            "Done": {"type": "checkbox", "checkbox": False},
        }}], "has_more": True, "next_cursor": "next"}
        result = services.items("notion", self.creds, "data-source")
        self.assertEqual(result["items"][0]["title"], "Write a poem")
        self.assertFalse(result["items"][0]["done"])
        self.assertTrue(result["items"][0]["canComplete"])
        self.assertEqual(result["nextCursor"], "next")
        self.assertIn("/data_sources/data-source/query", request.call_args.args[1])

    @patch("integration_services.request_json")
    def test_notion_does_not_guess_when_completion_checkbox_is_ambiguous(self, request):
        request.return_value = {"parent": {"data_source_id": "source"}, "properties": {
            "Done": {"type": "checkbox", "checkbox": False},
            "Completed": {"type": "checkbox", "checkbox": False},
        }}
        with self.assertRaises(IntegrationError):
            services.complete("notion", self.creds, "source", "page", True)
        request.assert_called_once()

    @patch("integration_services.request_json")
    def test_gmail_reads_metadata_and_never_marks_read(self, request):
        def reply(method, url, **kwargs):
            self.assertEqual(method, "GET")
            if urlsplit(url).path.endswith("/messages"):
                return {"messages": [{"id": "email", "threadId": "thread"}], "nextPageToken": "next"}
            self.assertEqual(parse_qs(urlsplit(url).query)["format"], ["metadata"])
            return {"threadId": "thread", "payload": {"headers": [{"name": "Subject", "value": "Plan our day"}]}}
        request.side_effect = reply
        result = services.items("gmail", self.creds, "STARRED")
        self.assertEqual(result["items"][0]["title"], "Plan our day")
        self.assertEqual(result["items"][0]["kind"], "message")
        self.assertEqual(result["nextCursor"], "next")

    @patch("integration_services.request_json")
    def test_slack_uses_message_permalink_and_small_history_page(self, request):
        def reply(method, url, **kwargs):
            self.assertEqual(method, "GET")
            if urlsplit(url).path.endswith("conversations.history"):
                self.assertEqual(parse_qs(urlsplit(url).query)["limit"], ["15"])
                return {"ok": True, "messages": [{"ts": "123.456", "text": "Read <https://example.com|this> &amp; write"}],
                        "response_metadata": {"next_cursor": "next"}}
            return {"ok": True, "permalink": "https://work.slack.com/archives/C1/p123456"}
        request.side_effect = reply
        result = services.items("slack", self.creds, "C1")
        self.assertEqual(result["items"][0]["title"], "Read this & write")
        self.assertEqual(result["items"][0]["url"], "https://work.slack.com/archives/C1/p123456")
        self.assertEqual(result["nextCursor"], "next")

    @patch("integration_services.request_json")
    def test_discord_missing_message_intent_reports_actionable_error(self, request):
        request.return_value = [{"id": "123", "content": "", "attachments": [], "type": 0}]
        with self.assertRaisesRegex(IntegrationError, "Message Content"):
            services.items("discord", {**self.creds, "resource": "456"}, "789")
        self.assertEqual(request.call_args.kwargs["headers"]["Authorization"], "Bot test-token")

    @patch("integration_services.request_json")
    def test_unsafe_urls_are_omitted_and_titles_bounded(self, request):
        request.return_value = {"data": [{"gid": "task", "name": "A" * 1000, "permalink_url": "javascript:alert(1)"}]}
        result = services.items("asana", self.creds, "project")
        self.assertNotIn("url", result["items"][0])
        self.assertEqual(len(result["items"][0]["title"]), 500)

    @patch("integration_services.request_json")
    def test_malformed_credentials_and_repository_fail_before_network(self, request):
        for token in ["", "key\r\ninjected: value", "☁"]:
            with self.subTest(token=token), self.assertRaises(IntegrationError):
                services.sources("linear", {"token": token})
        with self.assertRaises(IntegrationError):
            services.items("github", self.creds, "owner/repo/../../other")
        request.assert_not_called()


if __name__ == "__main__":
    unittest.main()

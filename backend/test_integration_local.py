"""No real macOS app access or network deliveries: every boundary is mocked."""

import json
import os
import socket
import subprocess
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import integration_local as local
from integration_http import IntegrationError

NATIVE = {"token": "native"}
ZAPIER = {"token": "https://hooks.zapier.com/hooks/catch/12345/abcdef/"}
N8N = {"token": "https://quiet-desk.app.n8n.cloud/webhook/my-secret-hook"}
PUBLIC_ADDRESS = (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("1.1.1.1", 443))
PRIVATE_ADDRESS = (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("127.0.0.1", 443))


def script_response(data, returncode=0, stderr=""):
    return SimpleNamespace(returncode=returncode, stdout=json.dumps(data), stderr=stderr)


@patch.object(local.sys, "platform", "darwin")
class RemindersTests(unittest.TestCase):
    @patch.object(local.subprocess, "run")
    def test_connect_lists_through_fixed_native_script(self, run):
        run.return_value = script_response([{"id": "list-id", "name": "Slow morning"}])
        self.assertEqual(local.sources("apple-reminders", NATIVE), [{"id": "list-id", "name": "Slow morning"}])
        args, kwargs = run.call_args
        self.assertEqual(args[0], ["/usr/bin/osascript", "-l", "JavaScript", "-e", local._LISTS_SCRIPT, "--"])
        self.assertEqual(kwargs["timeout"], local.REMINDERS_TIMEOUT)
        self.assertNotIn("shell", kwargs)

    @patch.object(local.subprocess, "run")
    def test_item_ids_cannot_become_script_code_and_pagination_survives(self, run):
        injected = '\"); Application("Terminal").doScript("unexpected"); //'
        run.return_value = script_response({"items": [{"id": "task-id", "title": "Tea & a chapter", "done": False}], "nextCursor": "200"})
        result = local.items("apple-reminders", NATIVE, injected, "100")
        command = run.call_args.args[0]
        self.assertEqual(command[4], local._ITEMS_SCRIPT)
        self.assertNotIn(injected, command[4])
        self.assertEqual(command[6:], [injected, "100"])
        self.assertEqual(result, {"items": [{"id": "task-id", "title": "Tea & a chapter", "done": False, "kind": "task"}], "nextCursor": "200"})

    @patch.object(local.subprocess, "run")
    def test_completion_and_reopening_send_only_explicit_boolean(self, run):
        for done in (True, False):
            with self.subTest(done=done):
                run.return_value = script_response({"done": done})
                local.complete("apple-reminders", NATIVE, "list-id", "reminder-id", done)
                self.assertEqual(run.call_args.args[0][4], local._COMPLETE_SCRIPT)
                self.assertEqual(run.call_args.args[0][6:], ["list-id", "reminder-id", str(done).lower()])

    @patch.object(local.subprocess, "run")
    def test_missing_item_or_unconfirmed_completion_does_not_report_success(self, run):
        for response, status in (({"error": "missing-item"}, 404), ({"done": False}, 502)):
            with self.subTest(response=response):
                run.return_value = script_response(response)
                with self.assertRaises(IntegrationError) as caught:
                    local.complete("apple-reminders", NATIVE, "list-id", "reminder-id", True)
                self.assertEqual(caught.exception.status, status)

    @patch.object(local.subprocess, "run")
    def test_non_mac_and_invalid_native_credential_never_launch_automation(self, run):
        with patch.object(local.sys, "platform", "linux"):
            with self.assertRaisesRegex(IntegrationError, "backend running on your Mac"):
                local.sources("apple-reminders", NATIVE)
        with self.assertRaisesRegex(IntegrationError, "native Mac"):
            local.sources("apple-reminders", {"token": "not-native"})
        run.assert_not_called()

    @patch.object(local.subprocess, "run")
    def test_bad_pagination_and_non_boolean_completion_do_not_launch_automation(self, run):
        for cursor in ("-1", "one", "1", "1000001", "10000000", True):
            with self.subTest(cursor=cursor), self.assertRaises(IntegrationError):
                local.items("apple-reminders", NATIVE, "list-id", cursor)
        with self.assertRaises(IntegrationError):
            local.complete("apple-reminders", NATIVE, "list-id", "reminder-id", "false")
        run.assert_not_called()

    @patch.object(local.subprocess, "run")
    def test_os_permission_and_timeout_errors_are_clear_and_do_not_expose_stderr(self, run):
        run.return_value = script_response(None, returncode=1, stderr="sensitive local details: not authorized (-1743)")
        with self.assertRaises(IntegrationError) as denied:
            local.sources("apple-reminders", NATIVE)
        self.assertEqual(denied.exception.status, 403)
        self.assertIn("Automation", str(denied.exception))
        self.assertNotIn("sensitive", str(denied.exception))
        run.side_effect = subprocess.TimeoutExpired("osascript", local.REMINDERS_TIMEOUT)
        with self.assertRaises(IntegrationError) as timeout:
            local.sources("apple-reminders", NATIVE)
        self.assertEqual(timeout.exception.status, 504)

    @patch.object(local.subprocess, "run")
    def test_bad_bridge_results_are_rejected(self, run):
        for data in ("not-a-list", [{"id": "x"}], [{"id": 1, "name": "wrong"}]):
            with self.subTest(data=data), self.assertRaises(IntegrationError):
                run.return_value = script_response(data)
                local.sources("apple-reminders", NATIVE)
        run.return_value = script_response({"items": [{"id": "x", "title": "wrong", "done": "false"}]})
        with self.assertRaises(IntegrationError):
            local.items("apple-reminders", NATIVE, "list-id")


class WebhookTests(unittest.TestCase):
    @patch.object(local.socket, "getaddrinfo")
    @patch.object(local, "_PinnedHTTPSConnection")
    def test_configuring_or_reading_outbound_source_never_sends_or_resolves(self, connection, dns):
        for provider, creds in (("n8n", N8N), ("zapier", ZAPIER)):
            with self.subTest(provider=provider):
                self.assertEqual(local.sources(provider, creds), [{"id": "outbound", "name": "Send a task to your workflow"}])
                self.assertEqual(local.items(provider, creds, "outbound"), {"items": [], "nextCursor": None})
        connection.assert_not_called()
        dns.assert_not_called()

    def test_unapproved_hosts_protocols_paths_and_userinfo_are_rejected(self):
        urls = [
            "http://hooks.zapier.com/hooks/catch/123/abc/",
            "https://user:pass@hooks.zapier.com/hooks/catch/123/abc/",
            "https://@hooks.zapier.com/hooks/catch/123/abc/",
            "https://hooks.zapier.com.evil.example/hooks/catch/123/abc/",
            "https://hooks.zapier.com/hooks/catch/123/abc/#fragment",
            "https://hooks.zapier.com:444/hooks/catch/123/abc/",
            "https://hooks.zapier.com/other/path",
            "https://hooks.zapier.com/hooks/catch/123/../secret/",
            "https://hooks.zapier.com\\@127.0.0.1/hooks/catch/123/abc/",
            "https://hooks.zapier.com:bad/hooks/catch/123/abc/",
        ]
        for url in urls:
            with self.subTest(url=url), self.assertRaises(IntegrationError):
                local.sources("zapier", {"token": url})
        with patch.dict(os.environ, {"LOFAI_WEBHOOK_HOSTS": ""}):
            for host in ("127.0.0.1", "[::1]", "localhost", "desk.localhost", "desk.local", "my.app.n8n.cloud.evil.example", "own.example"):
                with self.subTest(host=host), self.assertRaises(IntegrationError):
                    local.sources("n8n", {"token": f"https://{host}/webhook/test"})

    def test_self_hosted_n8n_requires_exact_configured_hostname(self):
        with patch.dict(os.environ, {"LOFAI_WEBHOOK_HOSTS": "workflow.example.com, another.example.com"}):
            local.sources("n8n", {"token": "https://workflow.example.com/webhook/desk"})
            with self.assertRaises(IntegrationError):
                local.sources("n8n", {"token": "https://sub.workflow.example.com/webhook/desk"})
            with self.assertRaises(IntegrationError):
                local.sources("zapier", {"token": "https://workflow.example.com/hooks/catch/1/abc"})

    @patch.object(local.socket, "getaddrinfo")
    def test_private_or_mixed_dns_answers_are_rejected(self, dns):
        private_ips = ["127.0.0.1", "10.1.2.3", "192.168.1.2", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]
        for ip in private_ips:
            address = (socket.AF_INET6 if ":" in ip else socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (ip, 443))
            with self.subTest(ip=ip), self.assertRaises(IntegrationError):
                dns.return_value = [PUBLIC_ADDRESS, address]
                local._public_addresses("workflow.example.com")
        dns.return_value = [PUBLIC_ADDRESS]
        self.assertEqual(local._public_addresses("workflow.example.com"), [PUBLIC_ADDRESS])

    @patch.object(local.socket, "getaddrinfo", return_value=[PUBLIC_ADDRESS])
    @patch.object(local, "_PinnedHTTPSConnection")
    def test_send_posts_only_task_fields_and_accepts_empty_success(self, connection_type, dns):
        connection = connection_type.return_value
        connection.getresponse.return_value = SimpleNamespace(status=204)
        result = local.send("zapier", ZAPIER, {"title": "  Take a breath 🌱  ", "done": True, "url": "https://example.com/task", "token": "never send", "connection": "never send"})
        self.assertEqual(result, {"delivered": True})
        connection_type.assert_called_once_with("hooks.zapier.com", [PUBLIC_ADDRESS])
        args, kwargs = connection.request.call_args
        self.assertEqual(args, ("POST", "/hooks/catch/12345/abcdef/"))
        self.assertEqual(json.loads(kwargs["body"]), {"title": "Take a breath 🌱", "done": True, "url": "https://example.com/task"})
        self.assertEqual(kwargs["headers"]["Content-Type"], "application/json")
        self.assertNotIn("Authorization", kwargs["headers"])
        connection.close.assert_called_once()

    @patch.object(local.socket, "getaddrinfo", return_value=[PUBLIC_ADDRESS])
    @patch.object(local, "_PinnedHTTPSConnection")
    def test_redirects_fail_without_following_or_repeating_delivery(self, connection_type, dns):
        connection = connection_type.return_value
        connection.getresponse.return_value = SimpleNamespace(status=307)
        with self.assertRaisesRegex(IntegrationError, "redirect"):
            local.send("n8n", N8N, {"title": "Read", "done": False})
        connection.request.assert_called_once()
        connection.close.assert_called_once()

    @patch.object(local.socket, "getaddrinfo", return_value=[PUBLIC_ADDRESS])
    @patch.object(local, "_PinnedHTTPSConnection")
    def test_failed_or_uncertain_deliveries_are_not_reported_delivered(self, connection_type, dns):
        connection = connection_type.return_value
        for status in (400, 401, 404, 429, 500):
            with self.subTest(status=status), self.assertRaises(IntegrationError):
                connection.getresponse.return_value = SimpleNamespace(status=status)
                local.send("zapier", ZAPIER, {"title": "Read", "done": False})
        connection.getresponse.side_effect = TimeoutError("secret remote details")
        with self.assertRaisesRegex(IntegrationError, "history before sending again") as caught:
            local.send("zapier", ZAPIER, {"title": "Read", "done": False})
        self.assertNotIn("secret", str(caught.exception))

    @patch.object(local.socket, "getaddrinfo")
    @patch.object(local, "_PinnedHTTPSConnection")
    def test_invalid_payloads_never_connect(self, connection_type, dns):
        payloads = [None, {}, {"title": " "}, {"title": "x" * 2001}, {"title": "Read", "done": "false"}, {"title": "Read", "url": "javascript:alert(1)"}, {"title": "Read", "url": "https://user:secret@example.com"}]
        for payload in payloads:
            with self.subTest(payload=payload), self.assertRaises(IntegrationError):
                local.send("zapier", ZAPIER, payload)
        connection_type.assert_not_called()
        dns.assert_not_called()

    @patch.object(local.socket, "getaddrinfo")
    @patch.object(local.socket, "socket")
    @patch.object(local.ssl, "create_default_context")
    def test_tls_socket_uses_pinned_numeric_address_and_original_hostname(self, context, socket_type, dns):
        sock = socket_type.return_value
        connection = local._PinnedHTTPSConnection("workflow.example.com", [PUBLIC_ADDRESS])
        connection.connect()
        socket_type.assert_called_once_with(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP)
        sock.connect.assert_called_once_with(("1.1.1.1", 443))
        context.return_value.wrap_socket.assert_called_once_with(sock, server_hostname="workflow.example.com")
        dns.assert_not_called()
        connection.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)

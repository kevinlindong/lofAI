"""Serve the static export in out/ for the production launcher.

The page is entirely client-side, so one file server replaces a Next.js
server and its render workers beside the model. Compared with
`python -m http.server`, unknown paths get the app's own 404 page and
directories without an index are not listed.
"""

import argparse
import functools
import http.server
import os


class ExportHandler(http.server.SimpleHTTPRequestHandler):
    def list_directory(self, path):
        self.send_error(404)
        return None

    def send_error(self, code, message=None, explain=None):
        page = os.path.join(self.directory, "404.html")
        if code != 404 or not os.path.isfile(page):
            return super().send_error(code, message, explain)
        with open(page, "rb") as handle:
            body = handle.read()
        self.send_response(404)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def end_headers(self):
        # Hashed build assets never change under the same name.
        if self.path.startswith("/_next/static/"):
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=3000)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--directory", default="out")
    args = parser.parse_args()
    handler = functools.partial(ExportHandler, directory=os.path.abspath(args.directory))
    with http.server.ThreadingHTTPServer((args.bind, args.port), handler) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()

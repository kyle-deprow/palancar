from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os


PAYLOAD = json.dumps(
    {
        "alias": "palancar-generation",
        "backend": os.environ.get("PALANCAR_LITELLM_BACKEND"),
        "upstreamModel": os.environ.get("PALANCAR_LITELLM_UPSTREAM_MODEL"),
    },
    separators=(",", ":"),
).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/palancar/provider":
            self.send_response(404)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(b'{"error":"not found"}')
            return

        self.send_response(200)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(PAYLOAD)))
        self.end_headers()
        self.wfile.write(PAYLOAD)

    def log_message(self, format, *args):
        return


HTTPServer(("0.0.0.0", 4001), Handler).serve_forever()

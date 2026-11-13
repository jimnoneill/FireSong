#!/usr/bin/env python3
"""Serve the probe directory over HTTPS on loopback (S1 trust tests).

    python3 serve_tls.py PORT CERT.pem KEY.pem [DIR]

Plain http is served with `python3 -m http.server PORT --bind 127.0.0.1`.
"""
import functools
import http.server
import ssl
import sys


def main() -> None:
    port, cert, key = int(sys.argv[1]), sys.argv[2], sys.argv[3]
    directory = sys.argv[4] if len(sys.argv) > 4 else "."
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    print(f"https://localhost:{port}/ serving {directory}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()

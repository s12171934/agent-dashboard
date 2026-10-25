"""The threaded HTTP server."""

import sys
from http.server import ThreadingHTTPServer


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # A tab closed or a phone that slept mid-response is routine; it used to leave a traceback per hangup.
        if isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)

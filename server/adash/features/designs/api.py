"""Design document endpoints."""

from urllib.parse import parse_qs

from adash.features.designs.service import design_doc, design_file, design_list, session_design_refs


def get_designs(h, url):
    h.send_json(design_list())


def get_design(h, url):
    h.send_json(*design_doc((parse_qs(url.query).get("path") or [""])[0]))


def get_design_file(h, url):
    body, status = design_file((parse_qs(url.query).get("path") or [""])[0])
    if not body:
        return h.send_json({"error": "not found" if status == 404 else "파일이 너무 큼"}, status)
    h.send_response(200)
    h.send_header("Content-Type", body[1])
    h.send_header("Content-Length", str(len(body[0])))
    h.send_header("Cache-Control", "no-cache")
    if body[1] == "image/svg+xml":  # an SVG opened on its own must not run its scripts on this origin
        h.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:")
    h.send_header("X-Content-Type-Options", "nosniff")
    h.end_headers()
    h.wfile.write(body[0])


def get_design_refs(h, url):
    h.send_json({"refs": session_design_refs((parse_qs(url.query).get("session") or [""])[0])})

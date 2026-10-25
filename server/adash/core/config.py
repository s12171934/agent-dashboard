"""Paths every part of the server shares. VAULT is rebound by main() from --vault."""

import os

HOME = os.path.expanduser("~")
# server/: prefs.json, the caches and server.log live here, next to server.py
HERE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
VAULT = os.path.join(HOME, "Obsidian/obsidian")

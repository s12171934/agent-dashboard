#!/usr/bin/env python3
"""Compatibility entry point for the native Rust regression suite."""
import os
from pathlib import Path
root = Path(__file__).resolve().parents[1]
os.execv(str(root / "server/atest"), ["atest", "run", "--label", '서버 session-title 검증', "--", str(root / "server/cargo"), "test", "--locked", '--test', 'contracts', 'rename_outranks_generated_title'])

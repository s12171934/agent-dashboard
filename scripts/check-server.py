#!/usr/bin/env python3
"""Compatibility entry point for the Rust compiler and lint checks."""
import os
from pathlib import Path
root = Path(__file__).resolve().parents[1]
os.execv(str(root / "server/cargo"), ["cargo", "clippy", "--locked", "--all-targets", "--", "-D", "warnings"])

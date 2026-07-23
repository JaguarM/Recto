#!/usr/bin/env python
"""Management entry point for the Recto demo app.

Run from anywhere: ``python demo/manage.py runserver 5001``.
The demo is a standalone Django project living inside the Recto repo; it
imports Recto's ``pdf_core.logic`` server modules but shares no settings,
URLs, or registry with the main app.
"""
import os
import sys
from pathlib import Path


def main():
    demo_dir = Path(__file__).resolve().parent
    # 'server' and 'viewer' live under demo/; pdf_core lives at the repo root.
    sys.path.insert(0, str(demo_dir))
    sys.path.insert(0, str(demo_dir.parent))
    os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'server.settings')
    from django.core.management import execute_from_command_line
    execute_from_command_line(sys.argv)


if __name__ == '__main__':
    main()

"""Settings for the Recto demo — a minimal, single-page showcase app.

Reuses Recto's server logic by import (pdf_core.logic.document_store /
document_loader) and serves the OCR engine + glyph static files straight from
ocr_tool/static (those are synced verbatim from the external char_training
repo and must never be copied or edited).

BASE_DIR is the REPO root, not demo/: document_store derives its cache dir
from settings.BASE_DIR, so the demo shares media/doc_cache with Recto.
"""
import os
import sys
from pathlib import Path

DEMO_DIR = Path(__file__).resolve().parent.parent   # demo/
BASE_DIR = DEMO_DIR.parent                          # repo root

for _p in (str(DEMO_DIR), str(BASE_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

SECRET_KEY = os.environ.get('DJANGO_SECRET_KEY', 'demo-only-not-secret')
DEBUG = os.environ.get('DJANGO_DEBUG', '1') != '0'
ALLOWED_HOSTS = os.environ.get('DJANGO_ALLOWED_HOSTS', 'localhost,127.0.0.1').split(',')

INSTALLED_APPS = [
    'django.contrib.staticfiles',
    'viewer',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'django.middleware.common.CommonMiddleware',
]

ROOT_URLCONF = 'server.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {'context_processors': []},
    },
]

WSGI_APPLICATION = None
DATABASES = {}

USE_TZ = True

DATA_UPLOAD_MAX_MEMORY_SIZE = 52428800  # 50 MB
FILE_UPLOAD_MAX_MEMORY_SIZE = 52428800

STATIC_URL = 'static/'
# ocr_tool/static exposes /static/ocr_tool/engine/*.js and glyphs/* exactly at
# the paths the engine expects (same layout as in Recto).
STATICFILES_DIRS = [BASE_DIR / 'ocr_tool' / 'static']

# Setup & Deployment

This section covers everything needed to run Recto, from local development to production server deployment.

## Contents

| Document | Description |
|----------|-------------|
| [Local Development](local-development.md) | Setting up a dev environment on Windows or Linux |
| [Production Deployment](production-deployment.md) | Full Linux server setup with Gunicorn, Nginx, and SSL |

## Prerequisites

- **Python 3.10+**
- **pip** and **venv**
- System libraries: `libgl1`, `libglib2.0-0`, `libharfbuzz-dev` (Linux)
- Microsoft Core Fonts (for accurate width calculation)

## Dependencies

| Package | Purpose |
|---------|---------|
| `django` | Web framework |
| `opencv-python-headless` | Image analysis (box detection) |
| `numpy` | Array operations for image processing |
| `pymupdf` | PDF parsing and image extraction |
| `pillow` | Image format conversions, mask generation |
| `uharfbuzz` | Precision text shaping with kerning support |
| `gunicorn` | Production WSGI server |

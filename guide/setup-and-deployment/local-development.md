# Local Development

## Quick Start

### Windows

```powershell
# 1. Clone and enter project
cd recto

# 2. Create virtual environment
python -m venv venv
.\venv\Scripts\Activate.ps1

# 3. Install dependencies
pip install -r requirements.txt

# 4. Run database migrations
python manage.py migrate

# 5. Start dev server
python manage.py runserver
```

Open [http://localhost:8000](http://localhost:8000) in your browser.

### Linux

```bash
# 1. Install system dependencies
sudo apt-get install -y python3-pip python3-venv libgl1 libglib2.0-0 \
    build-essential libharfbuzz-bin libharfbuzz-dev

# 2. Install Microsoft fonts (required for accurate width measurement)
echo ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula \
    select true | sudo debconf-set-selections
sudo apt-get install -y fontconfig ttf-mscorefonts-installer
sudo fc-cache -fv

# 3. Setup venv + install
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# 4. Migrate and run
python3 manage.py migrate
python3 manage.py runserver
```

Or use the provided script:

```bash
chmod +x run_app.sh
./run_app.sh
```

This starts the server on port 5000 and auto-opens a browser.

---

## Adding Fonts

Place `.ttf` font files in `assets/fonts/`. The width calculator scans this directory automatically and makes all fonts available in the frontend dropdown.

Common fonts to add:
- `times.ttf` (Times New Roman)
- `arial.ttf`
- `cour.ttf` (Courier New)
- `calibri.ttf`

## Collecting Static Files

During development, Django's `staticfiles` app serves files directly from the `static/` folders of each app (`pdf_core`, `webgl_mask`, `text_tool`). For production, run:

```bash
python manage.py collectstatic --noinput
```

This copies all static assets to the `STATIC_ROOT` (`static/` at project root).

## Running Tests

```bash
cd tests/
python -m pytest test_app.py
```

> **Note:** `test_app.py` currently tests against the legacy Flask `app.py`. To test the Django views, use `python manage.py test pdf_core`.

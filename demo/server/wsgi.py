import os
import sys
from pathlib import Path

demo_dir = Path(__file__).resolve().parent.parent
for p in (str(demo_dir), str(demo_dir.parent)):
    if p not in sys.path:
        sys.path.insert(0, p)

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'server.settings')

from django.core.wsgi import get_wsgi_application

application = get_wsgi_application()

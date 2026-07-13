@echo off
echo Starting Recto...
python -m pip install -r requirements.txt
start http://localhost:5000
python manage.py runserver 5000
pause

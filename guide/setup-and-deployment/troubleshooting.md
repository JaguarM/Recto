# Server Troubleshooting Guide

If your website doesn't load after a fresh installation, run through these diagnostic steps in order. Run all commands on your server as `root` (or prefix with `sudo`).

## 1. Check Nginx Status and Logs

First, see if the web server (Nginx) is running:

```bash
sudo systemctl status nginx
```

If it is running, check the Nginx error logs to see why the page isn't loading:
```bash
sudo tail -n 50 /var/log/nginx/error.log
```
* **"Connection refused"**: Nginx can't communicate with the backend (Gunicorn). (Go to Step 2)
* **"Permission denied"**: Nginx can't read the socket or files. (Go to Step 3)

## 2. Check the Gunicorn Service (recto)

See if the backend Django app is successfully running:

```bash
sudo systemctl status recto
```

If it has an error or is failing repeatedly, check the exact error message from Python/Gunicorn:
```bash
sudo journalctl -u recto -n 50 --no-pager
```

Common errors in the journal:
* **`ModuleNotFoundError: No module named ...`**: The virtual environment (`venv`) wasn't created properly or PIP dependencies failed to install.
* **`OperationalError: no such table`**: Database migrations haven't run. `cd /var/www/recto && source venv/bin/activate && python3 manage.py migrate`
* **`ImportError`** or WSGI errors: There is a bug in the code or a misconfiguration in `wsgi.py`.

## 3. Verify the Socket File

If both Nginx and Gunicorn show as active, verify the communication bridge (the `.sock` file):

```bash
ls -l /var/www/recto/recto.sock
```
* **If it does NOT exist**: Gunicorn is failing to start and create it, or doesn't have permissions to write to `/var/www/recto`.
* **If it is owned by `root`**: Nginx (`www-data`) cannot read it. 

**To automatically fix permissions and the socket:**
```bash
sudo chown -R www-data:www-data /var/www/recto
sudo systemctl daemon-reload
sudo systemctl restart recto
sudo systemctl restart nginx
```

## 4. Verify Static Files
If the page loads without CSS/styling, Django hasn't collected static files or Nginx isn't serving them. Ensure you ran:
```bash
cd /var/www/recto
source venv/bin/activate
python3 manage.py collectstatic --noinput
sudo chown -R www-data:www-data static/
```

## 5. Check the Firewall (UFW)

Make sure your server is actually allowing web traffic to reach Nginx:
```bash
sudo ufw status
```
If it says active, ensure HTTP and HTTPS are allowed:
```bash
sudo ufw allow 'Nginx Full'
```

The `?v=2` cache-buster worked locally, but production still serves the old JS file. This means the Django web server (Nginx/WhiteNoise/Apache) hasn't picked up the modified static files yet because `collectstatic` hasn't been run or the server hasn't been restarted.

Ran command: `Wait-Event -Timeout 1`

## 6. Working on Windows (your local dev machine) but not on the Linux web server
Django needs to collect and serve the updated static files in production.

On your production server, you need to:
1. Pull the latest code changes.
2. Run Django's collectstatic command so Nginx/WhiteNoise picks up the modified JS:
   `python manage.py collectstatic --noinput`
3. Restart gunicorn/your web server:
   `sudo systemctl restart gunicorn` (or whatever your service is named)

## Quick Diagnostic Command

Paste this command to get a quick overview of all the moving parts:
```bash
echo "--- NGINX ---" && systemctl is-active nginx && echo "--- GUNICORN ---" && systemctl is-active recto && echo "--- SOCKET ---" && ls -l /var/www/recto/recto.sock
```

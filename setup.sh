#!/bin/bash
set -e # Exit immediately if a command fails

# Colors for output
GREEN='\033[0;32m'
NC='\033[0m'

echo -e "${GREEN}Starting Installation for Recto...${NC}"

# 1. Update system & Install Fonts
echo -e "${GREEN}Updating system and installing dependencies...${NC}"
sudo apt-get update
sudo apt-get upgrade -y
# Pre-accept Microsoft Fonts license
echo ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true | sudo debconf-set-selections
sudo apt-get install -y python3-pip python3-venv nginx fontconfig ttf-mscorefonts-installer libgl1 libglib2.0-0 build-essential libharfbuzz-bin libharfbuzz-dev

# Refresh font cache
sudo fc-cache -fv

# 2. Setup Virtual Environment
# We assume we are already in /var/www/recto
if [ ! -d "venv" ]; then
    echo -e "${GREEN}Creating virtual environment...${NC}"
    python3 -m venv venv
else
    echo -e "${GREEN}Virtual environment already exists.${NC}"
fi

# 3. Install Python Packages
echo -e "${GREEN}Installing Python requirements...${NC}"
source venv/bin/activate
pip install -r requirements.txt
pip install gunicorn

# Migrate database
python3 manage.py migrate

# Collect static files
echo -e "${GREEN}Collecting static files...${NC}"
python3 manage.py collectstatic --noinput

# 4. Setup Service (Using your provided file)
echo -e "${GREEN}Installing Systemd Service...${NC}"
# Fix permissions so that www-data can create the socket and write to db.sqlite3
sudo chown -R www-data:www-data /var/www/recto

# ... hardcoded paths.
sudo cp recto.service /etc/systemd/system/

# Production settings via a systemd drop-in, so recto.service itself stays untouched.
# DEBUG defaults to on in settings.py for local dev; the server must turn it off.
sudo mkdir -p /etc/systemd/system/recto.service.d
printf '[Service]\nEnvironment="DJANGO_DEBUG=0"\n' | sudo tee /etc/systemd/system/recto.service.d/production.conf > /dev/null

# Reload the systemd daemon so it sees the new file
sudo systemctl daemon-reload
sudo systemctl restart recto
sudo systemctl enable recto

# 5. Setup Nginx (Using your provided file)
echo -e "${GREEN}Configuring Nginx...${NC}"
sudo cp nginx_app.conf /etc/nginx/sites-available/recto

# Link it
sudo ln -sf /etc/nginx/sites-available/recto /etc/nginx/sites-enabled/

# Remove default Nginx site
if [ -f /etc/nginx/sites-enabled/default ]; then
    sudo rm /etc/nginx/sites-enabled/default
fi

# Test and Restart Nginx
sudo nginx -t
sudo systemctl restart nginx

# 6. SSL Setup (Interactive)
echo -e "${GREEN}Starting SSL Setup...${NC}"
# Only install certbot if not present
if ! command -v certbot &> /dev/null; then
    sudo apt-get install -y certbot python3-certbot-nginx
fi

# Run certbot
sudo certbot --nginx -d unbarPDF.com

echo -e "${GREEN}Installation Complete! Check https://unbarPDF.com${NC}"
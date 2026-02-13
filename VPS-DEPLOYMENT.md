# VPS Deployment Guide

## Overview

This guide covers deploying the Crypto Portfolio Tracker to a VPS (Virtual Private Server) alongside multiple other sites using Nginx reverse proxy.

## Architecture

```
Internet (Port 80/443)
        ↓
   Nginx Reverse Proxy (yourdomain.com)
        ↓
   ├─→ Site 1 (localhost:3000) → site1.yourdomain.com
   ├─→ Site 2 (localhost:3001) → site2.yourdomain.com
   └─→ CryptoTracker (localhost:3002) → crypto.yourdomain.com
```

Each Next.js app runs on a different internal port, and Nginx routes traffic based on domain/subdomain.

## Prerequisites

- Ubuntu/Debian VPS with sudo access
- Node.js 18+ installed
- MongoDB installed (or MongoDB Atlas)
- Domain name pointing to your VPS IP
- SSL certificate (via Let's Encrypt)

## Step 1: System Setup

### Install Dependencies

| |
|---|
| `sudo apt update`<br>`sudo apt install -y nginx git curl build-essential`<br><br>`# Install Node.js 20 (via nvm)`<br>`curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh \| bash`<br>`source ~/.bashrc`<br>`nvm install 20`<br>`nvm use 20`<br><br>`# Install PM2 (process manager)`<br>`npm install -g pm2`<br><br>`# Install MongoDB (optional, if not using MongoDB Atlas)`<br>`wget -qO - https://www.mongodb.org/static/pgp/server-7.0.asc \| sudo apt-key add -`<br>`echo "deb [ arch=amd64,arm64 ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" \| sudo tee /etc/apt/sources.list.d/mongodb-org-7.0.list`<br>`sudo apt update`<br>`sudo apt install -y mongodb-org`<br>`sudo systemctl start mongod`<br>`sudo systemctl enable mongod` |

## Step 2: Deploy Application

### Clone and Build

| |
|---|
| `# Create app directory`<br>`sudo mkdir -p /var/www/crypto-tracker`<br>`sudo chown $USER:$USER /var/www/crypto-tracker`<br>`cd /var/www/crypto-tracker`<br><br>`# Clone repository`<br>`git clone https://github.com/yourusername/crypto-tracker.git .`<br><br>`# Install dependencies`<br>`npm install --production=false`<br><br>`# Build for production`<br>`npm run build` |

### Configure Environment

Create `/var/www/crypto-tracker/.env.production`:

| |
|---|
| `# Server Configuration`<br>`NODE_ENV=production`<br>`PORT=3002`<br><br>`# Application URL`<br>`NEXTAUTH_URL=https://crypto.yourdomain.com`<br>`NEXTAUTH_SECRET=generate-with-openssl-rand-base64-32`<br><br>`# Database`<br>`MONGODB_URI=mongodb://localhost:27017/crypto_prod`<br><br>`# Redis (Upstash)`<br>`UPSTASH_REDIS_REST_URL=your-redis-url`<br>`UPSTASH_REDIS_REST_TOKEN=your-redis-token`<br><br>`# Binance API`<br>`BINANCE_API_URL=https://api.binance.com`<br>`NEXT_PUBLIC_BINANCE_WS_URL=wss://stream.binance.com:9443`<br><br>`# OAuth Providers`<br>`GOOGLE_CLIENT_ID=your-google-client-id`<br>`GOOGLE_CLIENT_SECRET=your-google-client-secret`<br>`GITHUB_CLIENT_ID=your-github-client-id`<br>`GITHUB_CLIENT_SECRET=your-github-client-secret`<br><br>`# Cron Security`<br>`CRON_SECRET=generate-another-secret` |

Generate secrets:

| |
|---|
| `openssl rand -base64 32` |

### Seed Database (Optional)

| |
|---|
| `npm run seed` |

## Step 3: PM2 Process Manager

### Create PM2 Config

Create `/var/www/crypto-tracker/ecosystem.config.js`:

| |
|---|
| `module.exports = {`<br>`  apps: [{`<br>`    name: 'crypto-tracker',`<br>`    script: 'node_modules/next/dist/bin/next',`<br>`    args: 'start',`<br>`    cwd: '/var/www/crypto-tracker',`<br>`    instances: 1,`<br>`    exec_mode: 'cluster',`<br>`    env: {`<br>`      NODE_ENV: 'production',`<br>`      PORT: 3002,`<br>`    },`<br>`    env_file: '/var/www/crypto-tracker/.env.production',`<br>`    error_file: '/var/log/pm2/crypto-tracker-error.log',`<br>`    out_file: '/var/log/pm2/crypto-tracker-out.log',`<br>`    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',`<br>`    max_memory_restart: '500M',`<br>`    min_uptime: '10s',`<br>`    max_restarts: 10,`<br>`  }]`<br>`}` |

### Start with PM2

| |
|---|
| `# Create log directory`<br>`sudo mkdir -p /var/log/pm2`<br>`sudo chown $USER:$USER /var/log/pm2`<br><br>`# Start application`<br>`pm2 start ecosystem.config.js`<br><br>`# Save PM2 process list`<br>`pm2 save`<br><br>`# Setup PM2 to start on boot`<br>`pm2 startup systemd`<br>`# Run the command it outputs (with sudo)` |

### PM2 Commands

| |
|---|
| `pm2 status                 # View status`<br>`pm2 logs crypto-tracker    # View logs`<br>`pm2 restart crypto-tracker # Restart app`<br>`pm2 stop crypto-tracker    # Stop app`<br>`pm2 delete crypto-tracker  # Remove from PM2` |

## Step 4: Nginx Reverse Proxy

### Install SSL Certificate (Let's Encrypt)

| |
|---|
| `sudo apt install -y certbot python3-certbot-nginx`<br>`sudo certbot --nginx -d crypto.yourdomain.com` |

### Configure Nginx

Create `/etc/nginx/sites-available/crypto-tracker`:

| |
|---|
| `# Redirect HTTP to HTTPS`<br>`server {`<br>`    listen 80;`<br>`    server_name crypto.yourdomain.com;`<br>`    return 301 https://$server_name$request_uri;`<br>`}`<br><br>`# HTTPS Server`<br>`server {`<br>`    listen 443 ssl http2;`<br>`    server_name crypto.yourdomain.com;`<br><br>`    # SSL certificates (managed by certbot)`<br>`    ssl_certificate /etc/letsencrypt/live/crypto.yourdomain.com/fullchain.pem;`<br>`    ssl_certificate_key /etc/letsencrypt/live/crypto.yourdomain.com/privkey.pem;`<br>`    include /etc/letsencrypt/options-ssl-nginx.conf;`<br>`    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;`<br><br>`    # Security headers`<br>`    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;`<br>`    add_header X-Frame-Options "SAMEORIGIN" always;`<br>`    add_header X-Content-Type-Options "nosniff" always;`<br>`    add_header X-XSS-Protection "1; mode=block" always;`<br><br>`    # Proxy to Next.js app on port 3002`<br>`    location / {`<br>`        proxy_pass http://localhost:3002;`<br>`        proxy_http_version 1.1;`<br>`        proxy_set_header Upgrade $http_upgrade;`<br>`        proxy_set_header Connection 'upgrade';`<br>`        proxy_set_header Host $host;`<br>`        proxy_cache_bypass $http_upgrade;`<br>`        proxy_set_header X-Real-IP $remote_addr;`<br>`        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`<br>`        proxy_set_header X-Forwarded-Proto $scheme;`<br>`    }`<br><br>`    # Rate limiting (optional)`<br>`    limit_req_zone $binary_remote_addr zone=api_limit:10m rate=10r/s;`<br>`    location /api/ {`<br>`        limit_req zone=api_limit burst=20 nodelay;`<br>`        proxy_pass http://localhost:3002;`<br>`        proxy_http_version 1.1;`<br>`        proxy_set_header Host $host;`<br>`        proxy_set_header X-Real-IP $remote_addr;`<br>`        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`<br>`        proxy_set_header X-Forwarded-Proto $scheme;`<br>`    }`<br>`}` |

### Enable Site

| |
|---|
| `sudo ln -s /etc/nginx/sites-available/crypto-tracker /etc/nginx/sites-enabled/`<br>`sudo nginx -t`<br>`sudo systemctl reload nginx` |

## Step 5: Database Setup

### Option A: Local MongoDB

| |
|---|
| `# Create database and user`<br>`mongosh`<br><br>`use crypto_prod`<br>`db.createUser({`<br>`  user: "cryptoapp",`<br>`  pwd: "generate-secure-password",`<br>`  roles: [{ role: "readWrite", db: "crypto_prod" }]`<br>`})`<br><br>`# Update MONGODB_URI in .env.production`<br>`# MONGODB_URI=mongodb://cryptoapp:password@localhost:27017/crypto_prod` |

### Option B: MongoDB Atlas (Recommended)

1. Create cluster at https://cloud.mongodb.com
2. Whitelist VPS IP address
3. Create database user
4. Get connection string
5. Update `MONGODB_URI` in `.env.production`

## Step 6: Monitoring & Maintenance

### Logs

| |
|---|
| `# PM2 logs`<br>`pm2 logs crypto-tracker`<br><br>`# Nginx logs`<br>`sudo tail -f /var/log/nginx/access.log`<br>`sudo tail -f /var/log/nginx/error.log`<br><br>`# MongoDB logs`<br>`sudo tail -f /var/log/mongodb/mongod.log` |

### Updates

| |
|---|
| `cd /var/www/crypto-tracker`<br>`git pull origin main`<br>`npm install`<br>`npm run build`<br>`pm2 restart crypto-tracker` |

### Backup

| |
|---|
| `# MongoDB backup`<br>`mongodump --uri="mongodb://localhost:27017/crypto_prod" --out=/backup/mongo-$(date +%Y%m%d)`<br><br>`# Application backup`<br>`tar -czf /backup/app-$(date +%Y%m%d).tar.gz /var/www/crypto-tracker` |

### SSL Renewal

Certbot auto-renews. Test renewal:

| |
|---|
| `sudo certbot renew --dry-run` |

## Step 7: Multi-Site Setup

### Adding Additional Sites

For each site, assign a different port:

| Site | Port | Domain |
|---|---|---|
| Site 1 | 3000 | site1.yourdomain.com |
| Site 2 | 3001 | site2.yourdomain.com |
| CryptoTracker | 3002 | crypto.yourdomain.com |

Each site needs:
1. Separate directory in `/var/www/`
2. PM2 config with unique port
3. Nginx config with matching domain
4. SSL certificate via certbot

## Troubleshooting

### App won't start

| |
|---|
| `pm2 logs crypto-tracker --lines 100`<br>`# Check for environment variable issues`<br>`# Check MongoDB connection`<br>`# Check port availability: sudo lsof -i :3002` |

### 502 Bad Gateway

| |
|---|
| `# Check if app is running`<br>`pm2 status`<br><br>`# Check Nginx config`<br>`sudo nginx -t`<br><br>`# Check app logs`<br>`pm2 logs crypto-tracker` |

### MongoDB connection issues

| |
|---|
| `# Check MongoDB is running`<br>`sudo systemctl status mongod`<br><br>`# Test connection`<br>`mongosh $MONGODB_URI`<br><br>`# Check firewall (if using MongoDB Atlas)`<br>`# Whitelist VPS IP in Atlas` |

## Security Checklist

- [ ] Firewall configured (ufw allow 22,80,443)
- [ ] SSH key-only authentication
- [ ] MongoDB authentication enabled
- [ ] Environment variables not committed to git
- [ ] SSL certificate installed and auto-renewing
- [ ] Security headers in Nginx config
- [ ] Regular backups configured
- [ ] PM2 restart limits configured
- [ ] API rate limiting configured
- [ ] OAuth redirect URIs updated in Google/GitHub

## Performance Optimization

### Enable Nginx Caching

Add to Nginx config:

| |
|---|
| `proxy_cache_path /var/cache/nginx levels=1:2 keys_zone=nextjs_cache:10m max_size=10g inactive=60m;`<br><br>`location /_next/static/ {`<br>`    proxy_cache nextjs_cache;`<br>`    proxy_cache_valid 200 60m;`<br>`    proxy_pass http://localhost:3002;`<br>`}` |

### Enable Gzip

| |
|---|
| `gzip on;`<br>`gzip_vary on;`<br>`gzip_proxied any;`<br>`gzip_comp_level 6;`<br>`gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;` |

## Cost Optimization

- Use MongoDB Atlas free tier (512MB)
- Use Upstash Redis free tier (10K commands/day)
- Single VPS can host multiple Next.js apps
- Consider CloudFlare CDN (free tier)

## References

- Next.js Deployment: https://nextjs.org/docs/deployment
- PM2 Documentation: https://pm2.keymetrics.io/docs/usage/quick-start/
- Nginx Reverse Proxy: https://www.nginx.com/blog/websocket-nginx/
- Let's Encrypt: https://letsencrypt.org/getting-started/

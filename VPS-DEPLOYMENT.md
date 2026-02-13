# VPS Deployment Guide

## Overview

This guide covers deploying the Crypto Portfolio Tracker to a VPS (Virtual Private Server) alongside multiple other sites using Caddy reverse proxy.

**Why Caddy?**
- Automatic HTTPS via Let's Encrypt
- Simpler configuration than Nginx
- No manual SSL certificate management
- Built-in HTTP/2 and HTTP/3 support

## Architecture

```
Internet (Port 80/443)
        ↓
   Caddy Reverse Proxy (Auto SSL)
        ↓
   ├─→ Site 1 (localhost:3000) → site1.yourdomain.com
   ├─→ Site 2 (localhost:3001) → site2.yourdomain.com
   └─→ CryptoTracker (localhost:3002) → crypto.yourdomain.com
```

Each Next.js app runs on a different internal port, and Caddy routes traffic based on domain/subdomain with automatic SSL.

## Prerequisites

- Ubuntu/Debian VPS with sudo access
- Node.js 18+ installed
- MongoDB installed (or MongoDB Atlas)
- Domain name(s) pointing to your VPS IP (A records)
- Caddy will handle SSL automatically

## Step 1: System Setup

### Install Dependencies

| |
|---|
| `sudo apt update`<br>`sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https git curl build-essential`<br><br>`# Install Caddy`<br>`curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \| sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg`<br>`curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \| sudo tee /etc/apt/sources.list.d/caddy-stable.list`<br>`sudo apt update`<br>`sudo apt install -y caddy`<br><br>`# Install Node.js 20 (via nvm)`<br>`curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh \| bash`<br>`source ~/.bashrc`<br>`nvm install 20`<br>`nvm use 20`<br><br>`# Install PM2 (process manager)`<br>`npm install -g pm2`<br><br>`# Install MongoDB (optional, if not using MongoDB Atlas)`<br>`wget -qO - https://www.mongodb.org/static/pgp/server-7.0.asc \| sudo apt-key add -`<br>`echo "deb [ arch=amd64,arm64 ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" \| sudo tee /etc/apt/sources.list.d/mongodb-org-7.0.list`<br>`sudo apt update`<br>`sudo apt install -y mongodb-org`<br>`sudo systemctl start mongod`<br>`sudo systemctl enable mongod` |

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

## Step 4: Caddy Reverse Proxy

### Configure Caddyfile

Edit `/etc/caddy/Caddyfile`:

| |
|---|
| `# CryptoTracker`<br>`crypto.yourdomain.com {`<br>`    reverse_proxy localhost:3002`<br>`    encode gzip`<br>`    header {`<br>`        Strict-Transport-Security "max-age=31536000; includeSubDomains"`<br>`        X-Frame-Options "SAMEORIGIN"`<br>`        X-Content-Type-Options "nosniff"`<br>`        X-XSS-Protection "1; mode=block"`<br>`    }`<br>`}`<br><br>`# Example: Add more sites`<br>`# site2.yourdomain.com {`<br>`#     reverse_proxy localhost:3001`<br>`#     encode gzip`<br>`# }` |

**That's it!** Caddy automatically:
- Obtains SSL certificates from Let's Encrypt
- Redirects HTTP to HTTPS
- Renews certificates automatically
- Handles HTTP/2 and HTTP/3

### Apply Configuration

| |
|---|
| `# Test configuration`<br>`sudo caddy validate --config /etc/caddy/Caddyfile`<br><br>`# Reload Caddy`<br>`sudo systemctl reload caddy`<br><br>`# Check status`<br>`sudo systemctl status caddy` |

### Verify DNS

Before Caddy can issue SSL certificates, ensure DNS is pointing to your VPS:

| |
|---|
| `# Check DNS resolution`<br>`dig crypto.yourdomain.com +short`<br>`# Should return your VPS IP address` |

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
| `# PM2 logs`<br>`pm2 logs crypto-tracker`<br><br>`# Caddy logs`<br>`sudo journalctl -u caddy --no-pager \| tail -n 50`<br>`sudo journalctl -u caddy -f  # Follow mode`<br><br>`# MongoDB logs`<br>`sudo tail -f /var/log/mongodb/mongod.log` |

### Updates

| |
|---|
| `cd /var/www/crypto-tracker`<br>`git pull origin main`<br>`npm install`<br>`npm run build`<br>`pm2 restart crypto-tracker` |

### Backup

| |
|---|
| `# MongoDB backup`<br>`mongodump --uri="mongodb://localhost:27017/crypto_prod" --out=/backup/mongo-$(date +%Y%m%d)`<br><br>`# Application backup`<br>`tar -czf /backup/app-$(date +%Y%m%d).tar.gz /var/www/crypto-tracker` |

### SSL Certificate Management

Caddy manages certificates automatically. No manual renewal needed!

Check certificate status:

| |
|---|
| `sudo caddy list-modules \| grep tls`<br>`# View certificate info in Caddy logs`<br>`sudo journalctl -u caddy \| grep certificate` |

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
3. Entry in Caddyfile with domain → port mapping
4. DNS A record pointing to VPS IP

Caddy handles SSL automatically for all domains!

## Troubleshooting

### App won't start

| |
|---|
| `pm2 logs crypto-tracker --lines 100`<br>`# Check for environment variable issues`<br>`# Check MongoDB connection`<br>`# Check port availability: sudo lsof -i :3002` |

### 502 Bad Gateway

| |
|---|
| `# Check if app is running`<br>`pm2 status`<br><br>`# Check Caddy config`<br>`sudo caddy validate --config /etc/caddy/Caddyfile`<br><br>`# Check Caddy logs`<br>`sudo journalctl -u caddy -n 50`<br><br>`# Check app logs`<br>`pm2 logs crypto-tracker` |

### MongoDB connection issues

| |
|---|
| `# Check MongoDB is running`<br>`sudo systemctl status mongod`<br><br>`# Test connection`<br>`mongosh $MONGODB_URI`<br><br>`# Check firewall (if using MongoDB Atlas)`<br>`# Whitelist VPS IP in Atlas` |

## Security Checklist

- [ ] Firewall configured (ufw allow 22,80,443)
- [ ] SSH key-only authentication
- [ ] MongoDB authentication enabled
- [ ] Environment variables not committed to git
- [ ] DNS A records pointing to VPS IP (for Caddy SSL)
- [ ] Security headers in Caddyfile
- [ ] Regular backups configured
- [ ] PM2 restart limits configured
- [ ] OAuth redirect URIs updated in Google/GitHub
- [ ] Caddy running and certificates obtained

## Performance Optimization

### Caddy Caching (Optional)

Add to Caddyfile for static assets:

| |
|---|
| `crypto.yourdomain.com {`<br>`    reverse_proxy localhost:3002`<br>`    encode gzip`<br><br>`    # Cache static assets`<br>`    @static {`<br>`        path /_next/static/*`<br>`    }`<br>`    header @static Cache-Control "public, max-age=31536000, immutable"`<br><br>`    # Security headers`<br>`    header {`<br>`        Strict-Transport-Security "max-age=31536000"`<br>`        X-Frame-Options "SAMEORIGIN"`<br>`        X-Content-Type-Options "nosniff"`<br>`    }`<br>`}` |

### Compression

Caddy enables gzip compression by default with `encode gzip` directive (already included above).

## Cost Optimization

- Use MongoDB Atlas free tier (512MB)
- Use Upstash Redis free tier (10K commands/day)
- Single VPS can host multiple Next.js apps
- Consider CloudFlare CDN (free tier)

## Caddy Advanced Configuration

### Multiple Sites Example

Complete `/etc/caddy/Caddyfile` for multiple sites:

| |
|---|
| `# Site 1`<br>`site1.yourdomain.com {`<br>`    reverse_proxy localhost:3000`<br>`    encode gzip`<br>`}`<br><br>`# Site 2`<br>`site2.yourdomain.com {`<br>`    reverse_proxy localhost:3001`<br>`    encode gzip`<br>`}`<br><br>`# CryptoTracker`<br>`crypto.yourdomain.com {`<br>`    reverse_proxy localhost:3002`<br>`    encode gzip`<br>`    header {`<br>`        Strict-Transport-Security "max-age=31536000"`<br>`        X-Frame-Options "SAMEORIGIN"`<br>`        X-Content-Type-Options "nosniff"`<br>`    }`<br>`}` |

### Rate Limiting (Optional)

| |
|---|
| `crypto.yourdomain.com {`<br>`    rate_limit {`<br>`        zone crypto_api {`<br>`            key {remote_host}`<br>`            events 100`<br>`            window 1m`<br>`        }`<br>`        zone_file /var/lib/caddy/ratelimit.json`<br>`    }`<br>`    reverse_proxy localhost:3002`<br>`}` |

## References

- Next.js Deployment: https://nextjs.org/docs/deployment
- PM2 Documentation: https://pm2.keymetrics.io/docs/usage/quick-start/
- Caddy Documentation: https://caddyserver.com/docs/
- Caddy Reverse Proxy: https://caddyserver.com/docs/quick-starts/reverse-proxy

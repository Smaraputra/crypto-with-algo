#!/bin/sh
set -e

# Substitute CRON_SECRET into crontab template using sed (no envsubst in alpine)
sed "s|\${CRON_SECRET}|${CRON_SECRET}|g" /etc/crontab.template > /var/spool/cron/crontabs/root

# Ensure log file exists
touch /var/log/cron.log

# Start crond in foreground, tailing the log
crond -f -l 2 &
exec tail -f /var/log/cron.log

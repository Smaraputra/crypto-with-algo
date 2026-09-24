#!/bin/sh
set -e

# An unset CRON_SECRET makes every crontab line send "Bearer " and every job
# 401 forever, with nothing in the log to say so -- indistinguishable from cron
# simply not running. Fail at boot instead of failing silently for weeks.
if [ -z "${CRON_SECRET}" ]; then
  echo "FATAL: CRON_SECRET is not set; every cron job would 401" >&2
  exit 1
fi

# Substitute CRON_SECRET into crontab template using sed (no envsubst in alpine).
# The | delimiter breaks on a secret containing |, and an unescaped & expands to
# the matched text, so both are rejected rather than silently corrupting the
# Authorization header.
case "${CRON_SECRET}" in
  *'|'*|*'&'*|*'\'*)
    echo "FATAL: CRON_SECRET contains | & or \\, which this sed substitution cannot carry" >&2
    exit 1
    ;;
esac

sed "s|\${CRON_SECRET}|${CRON_SECRET}|g" /etc/crontab.template > /var/spool/cron/crontabs/root
chmod 600 /var/spool/cron/crontabs/root

# Ensure log file exists
touch /var/log/cron.log

# crond is PID 1 and tail is the sidecar, not the other way round. Previously
# `crond -f &` then `exec tail -f` meant a dead crond left the container Up,
# `restart: unless-stopped` never fired, and every job stopped with every
# surface still reporting green.
#
# -F rather than -f so the tail survives the nightly in-place truncation of
# cron.log (the last line of crontab.template), which -f does not follow.
tail -F /var/log/cron.log &
exec crond -f -l 2

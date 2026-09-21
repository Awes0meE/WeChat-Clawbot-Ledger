#!/bin/sh
# Optional per-user helper for a dedicated Mac with system sleep already disabled.
# Sleep the display once on lid closure; never stop services or alter pmset settings.
set -eu

previous=unknown
while :; do
  lid=$(/usr/sbin/ioreg -r -n IOPMrootDomain -d 1 -l -w 0 |
    /usr/bin/sed -nE 's/^[[:space:]|]*"AppleClamshellState" = (Yes|No)$/\1/p')
  case "$lid" in
    Yes)
      if [ "$previous" != Yes ]; then
        /usr/bin/pmset displaysleepnow
        /bin/date '+%Y-%m-%dT%H:%M:%S%z lid closed: display sleep requested'
      fi
      ;;
    No) ;;
    *) echo 'Cannot read lid state; no display action taken' >&2; exit 1 ;;
  esac
  previous=$lid
  /bin/sleep 5
done

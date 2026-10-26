#!/bin/sh
# systemd (wmining-agent.service) bu betiği çalıştırır.
# Güncelleme sonrası yeni sürüm 3 açılışta da panele bağlanamazsa önceki sürüme döner.
AGENT_ROOT=/opt/wmining/agent
PENDING=/var/lib/wmining/update-pending

if [ -f "$PENDING" ]; then
  previous=$(sed -n 2p "$PENDING")
  tries=$(sed -n 3p "$PENDING")
  tries=$((${tries:-0} + 1))
  if [ "$tries" -gt 3 ] && [ -n "$previous" ] && [ -d "$previous" ]; then
    echo "Yeni agent sürümü çalışmadı, önceki sürüme dönülüyor: $previous"
    ln -sfn "$previous" "$AGENT_ROOT/current.new" && mv -Tf "$AGENT_ROOT/current.new" "$AGENT_ROOT/current"
    rm -f "$PENDING"
  else
    sed -i "3s/.*/$tries/" "$PENDING"
  fi
fi

cd "$AGENT_ROOT/current" || exit 1
exec /usr/bin/python3 -m whisperagent

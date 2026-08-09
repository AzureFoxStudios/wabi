FROM fedora:44
RUN dnf -y install openssl-libs ca-certificates wget \
 && dnf clean all
WORKDIR /app

# Pre-create runtime directories and grant ownership to the non-root user (UID/GID 1000).
# These will be bind-mounted from the host by docker-compose; the ownership here is what
# wabi-server (running as UID 1000) needs to read/write inside the container.
# /wabi-server is also bind-mounted read-only from ./target/release/wabi-server.
RUN groupadd -g 1000 wabi \
 && useradd -u 1000 -g 1000 -M -s /sbin/nologin wabi \
 && mkdir -p /data /app/uploads /app/plugins /home/wabi/.config/lore /var/wabi/lore \
 && chown -R 1000:1000 /data /app /wabi-server /home/wabi /var/wabi 2>/dev/null || true \
 && chmod 750 /data /app/uploads /app/plugins /var/wabi/lore

# Drop root privileges. wabi-server runs as UID 1000 going forward.
USER 1000:1000

ENTRYPOINT ["/wabi-server"]
FROM alpine:3.20

RUN apk add --no-cache \
    coturn \
    python3 \
    && mkdir -p /var/lib/coturn /etc/coturn/certs

COPY turnserver.conf.template /etc/coturn/turnserver.conf.template
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3478/tcp 3478/udp 49160-49200/udp

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["turnserver", "-c", "/etc/coturn/turnserver.conf"]

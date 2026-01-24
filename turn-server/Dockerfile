FROM coturn/coturn:latest

# Install gettext for envsubst command (environment variable substitution)
USER root
RUN apk add --no-cache gettext

# Copy configuration template and entrypoint script
COPY turnserver.conf.template /etc/coturn/turnserver.conf.template
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Make entrypoint executable
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Set the entrypoint
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

FROM coturn/coturn:latest

# Install gettext for envsubst command (environment variable substitution)
USER root
RUN apt-get update && \
    apt-get install -y --no-install-recommends gettext-base && \
    rm -rf /var/lib/apt/lists/*

# Copy configuration template and entrypoint script
COPY turnserver.conf.template /etc/coturn/turnserver.conf.template
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Make entrypoint executable
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Set the entrypoint
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends libssl3 ca-certificates wget \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENTRYPOINT ["/wabi-server"]

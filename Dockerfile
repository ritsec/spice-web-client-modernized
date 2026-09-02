# Development and test environment for the Spice Web Client.
#
# The image is a generic Node + headless-Chromium environment; the repository
# itself is NOT baked in — mount your checkout as a volume (see below).
#
# Build:
#   docker build -t spice-web-client-dev .
#
# Run (from the repository root):
#   docker run --rm -v "$PWD":/app spice-web-client-dev                    full test suite
#   docker run --rm -v "$PWD":/app spice-web-client-dev --filter queue     subset by name
#   docker run --rm -v "$PWD":/app spice-web-client-dev --list             list registered tests
#   docker run --rm -it -v "$PWD":/app --entrypoint sh spice-web-client-dev  interactive shell
#
# The test stack (unittest/index.html + unittest/runner.js + unittest/vendor/*)
# needs no npm install. See DEVELOPMENT.md for details.
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/chromium

WORKDIR /app
# Fixed entrypoint: any arguments passed to `docker run` are appended to this
# (e.g. --filter queue). Using ENTRYPOINT (instead of CMD) also avoids the
# node image's entrypoint script mis-parsing flags that start with "-".
ENTRYPOINT ["node", "tools/run-tests.mjs"]

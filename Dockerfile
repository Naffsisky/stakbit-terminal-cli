# stakbit in a browser, via ttyd.
#
# ## Why a browser wrapper at all
#
# `stakbit` is a TUI — it draws with ANSI escapes and expects a real terminal. To reach it at an
# IP:port, something has to provide that terminal. ttyd runs a real PTY and forwards it over a
# WebSocket to xterm.js, so the app needs no changes and the browser sees exactly what a local
# terminal would.
#
# ## Why the build stage is separate
#
# TypeScript and the type definitions are ~70 MB of dev dependencies. Shipping them in the runtime
# image would more than double its size for nothing, so the compile happens in `build` and only
# `dist/` plus the production dependency tree crosses over. There are no runtime dependencies, so
# that tree is empty and the result is small.
#
# ## Why ttyd is fetched rather than installed
#
# It is a single static Go binary with no dynamic libraries — `ldd` says "not a dynamic executable".
# A distro package would drag in a web server's worth of dependencies for one binary.
FROM node:22-alpine AS build

WORKDIR /app

# Copy the manifests first so a source-only change does not invalidate the install layer.
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

# Prove the binary works before it can be shipped. A build that compiles but cannot start is the
# failure this catches, and it is cheap here rather than at 3am in the cluster.
RUN node dist/cli.js version


FROM node:22-alpine AS runtime

# ttyd's own dependency is just libc, which alpine's musl does not provide for a glibc build, so the
# binary is fetched from the release that matches musl.
#
# Pinned to 1.6.3 deliberately. The 1.7.x builds from this project fail to spawn their PTY on this
# host — the log shows `uv_write: ESRCH (no such process)` the moment a client connects, and no child
# process is ever created, so the browser gets a blank terminal. Verified by running both versions
# side by side: 1.6.3 spawns and streams, 1.7.7 does not. Upgrading needs that retested, not assumed.
ARG TTYD_VERSION=1.6.3
RUN apk add --no-cache tini \
 && wget -q -O /usr/local/bin/ttyd \
      "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64" \
 && chmod +x /usr/local/bin/ttyd \
 && /usr/local/bin/ttyd --version

WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Run as a non-root user. The store lives in HOME, so it needs to be writable by that user and
# nothing else.
RUN addgroup -S -g 10001 stakbit \
 && adduser -S -u 10001 -G stakbit -h /home/stakbit stakbit \
 && mkdir -p /home/stakbit/.stakbit \
 && chown -R stakbit:stakbit /home/stakbit

# `stakbit` on PATH, and a session that shows the status banner before dropping to a prompt. A bare
# shell would leave a first-time visitor staring at nothing and guessing at the command names.
#
# Note the shell: ttyd runs this under /bin/sh (busybox ash on alpine), which has no `name() { }`
# function syntax. A `stakbit()` definition here is a syntax error at startup, so the wrapper binary
# on PATH is the only shim.
RUN printf '%s\n' \
      '#!/bin/sh' \
      'set -u' \
      'if [ -t 1 ]; then' \
      '  /usr/local/bin/stakbit status 2>/dev/null || true' \
      '  echo' \
      '  echo "Commands: watch | tape <SYMBOL> | quote <SYMBOL> | book <SYMBOL> | status"' \
      '  echo "Not signed in yet? Run: login --paste   (browser login needs a display)"' \
      '  echo' \
      'fi' \
      'exec /bin/sh -i' \
    > /usr/local/bin/stakbit-session \
 && chmod +x /usr/local/bin/stakbit-session \
 && printf '%s\n' \
      '#!/bin/sh' \
      'exec node /app/dist/cli.js "$@"' \
    > /usr/local/bin/stakbit \
 && chmod +x /usr/local/bin/stakbit

USER 10001:10001

ENV HOME=/home/stakbit \
    STAKBIT_HOME=/home/stakbit/.stakbit \
    TERM=xterm-256color

EXPOSE 7681

# `tini` reaps zombies. Without it, every command the user runs inside ttyd leaves a defunct process
# and a long-lived session slowly fills the process table.
ENTRYPOINT ["/sbin/tini", "--"]

# `-W` makes ttyd writable (the default is read-only, which would show the app but swallow every
# keypress). `--once` is deliberately NOT set: this is meant to be reconnected to.
CMD ["ttyd", \
     "--port", "7681", \
     "--interface", "0.0.0.0", \
     "--writable", \
     "--max-clients", "4", \
     "--terminal-type", "xterm-256color", \
     "/usr/local/bin/stakbit-session"]

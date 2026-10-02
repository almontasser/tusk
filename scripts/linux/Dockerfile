# Builds Tusk's Linux release (scripts/release.sh). Ubuntu 22.04 has the oldest glibc and WebKitGTK 4.1 that the
# release supports, so the AppImage and the .deb run there and on every newer distribution.
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl file git pkg-config xz-utils \
      libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libssl-dev libdbus-1-dev libxdo-dev \
    && rm -rf /var/lib/apt/lists/*
ARG NODE=24.19.0
RUN curl -fsSL "https://nodejs.org/dist/v$NODE/node-v$NODE-linux-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/').tar.xz" \
      | tar -xJ -C /usr/local --strip-components 1 \
    && npm install -g pnpm@11
ARG RUST=1.97.1
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain "$RUST"
ENV PATH=/root/.cargo/bin:$PATH
# The AppImage tools are AppImages themselves, and a container has no FUSE to mount them.
ENV APPIMAGE_EXTRACT_AND_RUN=1
WORKDIR /src

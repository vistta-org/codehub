# Vistta Code Hub host image. Build from the staged payload, not from the repo:
#   npm run install-runtime && npm run stage -- --target=build/docker
#   docker build -f docker/Dockerfile -t vistta/codehub build/docker
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git tini \
 && rm -rf /var/lib/apt/lists/*

ENV VCH_DATA_DIR=/data \
    VCH_PROJECTS_ROOT=/projects \
    VCH_SERVER_PORT=8181 \
    VCH_SHARE=true

WORKDIR /opt/vistta-codehub
COPY --chown=node:node . .
RUN mkdir -p /data /projects && chown node:node /data /projects

USER node
VOLUME ["/data", "/projects"]
EXPOSE 8181

# Loopback HTTP is always accepted by the hub, so the probe needs no certificate.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.VCH_SERVER_PORT || 8181) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]

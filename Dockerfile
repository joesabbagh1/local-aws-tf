# syntax=docker/dockerfile:1

# ── build: compile the UI (dist/) and the server bundle (dist-server/cli.cjs) ─────────────────
FROM node:22-alpine AS build
WORKDIR /repo
# No browsers in this image; Playwright is only used by host-run e2e tests
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── runtime: node + the tools the backend drives (terraform, zip, docker CLI, socat) ─────────
FROM node:22-alpine
ARG TARGETARCH
ARG TF_VERSION=1.10.5
RUN apk add --no-cache zip socat docker-cli \
  && wget -q -O /tmp/terraform.zip \
      "https://releases.hashicorp.com/terraform/${TF_VERSION}/terraform_${TF_VERSION}_linux_${TARGETARCH}.zip" \
  && unzip -o /tmp/terraform.zip -d /usr/local/bin \
  && rm /tmp/terraform.zip \
  && terraform version && zip --version | head -1

WORKDIR /app
COPY --from=build /repo/dist ./dist
COPY --from=build /repo/dist-server ./dist-server
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Project working dirs live on the mounted /projects volume; the default project is /projects/infra
ENV NODE_ENV=production
VOLUME ["/projects"]
EXPOSE 5173
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist-server/cli.cjs", "/projects/infra", "--port", "5173", "--host", "0.0.0.0"]

# Stage 1: Build the Docusaurus static site
FROM node:24-alpine AS builder

WORKDIR /app

RUN corepack enable

COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn ./.yarn
COPY apps/docs/package.json ./apps/docs/

RUN yarn workspaces focus official-modules-docs

COPY apps/docs ./apps/docs

WORKDIR /app/apps/docs
RUN yarn build

# Stage 2: Serve the build output
FROM node:24-alpine AS runner

RUN npm install -g serve@14

RUN addgroup -g 1001 -S docuser && \
    adduser -S -D -H -u 1001 -s /sbin/nologin -G docuser docuser

WORKDIR /app

COPY --from=builder /app/apps/docs/build ./build

RUN chown -R docuser:docuser /app

USER docuser

ENV PORT=4000
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4000/ || exit 1

CMD ["serve", "-s", "build", "-l", "4000"]

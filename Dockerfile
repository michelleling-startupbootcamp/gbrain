FROM oven/bun:1.1-debian AS builder

WORKDIR /app

# Install dependencies
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

# Copy source and build binary
COPY . .
RUN bun build --compile --outfile bin/gbrain src/cli.ts

# ---- Runtime stage ----
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/bin/gbrain /usr/local/bin/gbrain

# gbrain serve listens on PORT (default 3000) for HTTP MCP transport
EXPOSE 3000

ENV ENGINE=postgres
ENV NODE_ENV=production

CMD ["gbrain", "serve"]

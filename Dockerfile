FROM node:22-alpine

LABEL org.opencontainers.image.source="https://github.com/dashecorp/rig-memory-mcp"
LABEL org.opencontainers.image.description="Postgres + pgvector backed MCP memory server for the Dashecorp engineering rig"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Build tools required by better-sqlite3 native addon
RUN apk add --no-cache python3 make g++

# Install production deps only
COPY package*.json ./
RUN npm ci --omit=dev --omit=optional

COPY index.js db.js ./

# MCP server communicates over stdio — no ports needed
CMD ["node", "index.js"]

# Gantavyam backend (Express + Socket.IO + MongoDB) for Google Cloud Run
FROM node:22-slim

ENV NODE_ENV=production

# The app writes logs/ and uploads/ next to the code, so /app must belong to the non-root user
RUN mkdir -p /app && chown node:node /app
WORKDIR /app
USER node

# Install production dependencies first so this layer is cached between code changes
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

# Cloud Run sets PORT (8080 by default); server.js reads process.env.PORT
EXPOSE 8080
CMD ["node", "server.js"]

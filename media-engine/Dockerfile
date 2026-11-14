FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs ./
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","server.mjs"]

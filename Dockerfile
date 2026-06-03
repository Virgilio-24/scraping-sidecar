# Use the official Playwright image — comes with the exact Chromium version bundled
FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

RUN mkdir -p .sessions

EXPOSE 3002

CMD ["node", "src/server.js"]

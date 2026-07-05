FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app

# VNC + noVNC for remote CAPTCHA solving
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

RUN mkdir -p .sessions

# 3003 = API, 6080 = noVNC web UI
EXPOSE 3003 6080

ENV NODE_ENV=production \
    BROWSER_HEADLESS=true \
    PORT=3003 \
    DISPLAY=:99 \
    VNC_PORT=5900 \
    NOVNC_PORT=6080 \
    SCREEN_RESOLUTION=1920x1080x24

CMD ["/docker-entrypoint.sh"]

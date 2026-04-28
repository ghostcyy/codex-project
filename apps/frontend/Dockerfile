FROM node:22-bookworm-slim

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1 \
    PORT=3100 \
    HOSTNAME=0.0.0.0 \
    NEXT_PUBLIC_API_BASE_URL=/api \
    API_BASE_URL=http://backend:4100/api \
    PYTHON_BIN=/opt/video-tools-venv/bin/python \
    FFMPEG_BIN=/usr/bin/ffmpeg \
    FFPROBE_BIN=/usr/bin/ffprobe

RUN sed -i 's|http://deb.debian.org/debian|http://mirrors.aliyun.com/debian|g; s|http://deb.debian.org/debian-security|http://mirrors.aliyun.com/debian-security|g' /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/frontend/package.json apps/frontend/package.json
COPY apps/backend/package.json apps/backend/package.json

RUN npm ci --ignore-scripts

COPY . .

RUN python3 -m venv /opt/video-tools-venv \
  && /opt/video-tools-venv/bin/pip install --no-cache-dir -r requirements.txt

RUN npm run build --workspace @codex/frontend

ENV NODE_ENV=production

EXPOSE 3100

CMD ["npm", "run", "start", "--workspace", "@codex/frontend"]

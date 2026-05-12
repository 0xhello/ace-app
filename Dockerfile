FROM node:20-slim

# Python 3, pip, supervisor — all in one layer
RUN apt-get update && apt-get install -y \
    python3 python3-pip supervisor \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python deps (separate layer — cache busts only when requirements change)
COPY ml/requirements.txt ml/requirements.txt
RUN pip3 install --no-cache-dir -r ml/requirements.txt --break-system-packages

# Node deps
COPY package*.json ./
RUN npm ci

# Full source + build
COPY . .
RUN npm run build

# Next.js standalone needs static assets wired up alongside the server bundle
RUN cp -r .next/static .next/standalone/.next/static && \
    cp -r public .next/standalone/public

# Data directories — Railway volumes mount here at runtime
RUN mkdir -p ml/nba_spread/data ml/world_cup/data

ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1
ENV HOSTNAME=0.0.0.0

EXPOSE 3000

COPY supervisord.conf /etc/supervisor/conf.d/ace.conf
CMD ["/usr/bin/supervisord", "-n"]

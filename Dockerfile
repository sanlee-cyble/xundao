FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8731 \
    XUNDAO_DATA_DIR=/app/data \
    XUNDAO_RUNS_DIR=/app/runs \
    PGY_USER_DATA_DIR=/app/.pgy-browser-profile \
    PGY_BROWSER_CHANNEL=bundled

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY requirements.txt ./
RUN pip3 install --break-system-packages --no-cache-dir -r requirements.txt

COPY public ./public
COPY src ./src
COPY config ./config

RUN mkdir -p /app/data /app/runs /app/raw /app/outputs /app/.pgy-browser-profile /app/pgy-profiles

EXPOSE 8731

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8731/healthz').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "run", "web"]

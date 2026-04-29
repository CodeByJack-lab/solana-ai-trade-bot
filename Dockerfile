FROM node:20-slim

# Install Python, pip, and process tools
RUN apt-get update && apt-get install -y \
    python3 python3-pip python3-venv procps \
    && rm -rf /var/lib/apt/lists/*

# Install PM2 globally
RUN npm install -g pm2

WORKDIR /app

# Node dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Python virtual environment + dependencies
COPY requirements.txt ./
RUN python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --upgrade pip && \
    /opt/venv/bin/pip install -r requirements.txt

# Make venv python available as default 'python' interpreter
ENV PATH="/opt/venv/bin:$PATH"

# Copy application source
COPY . .

EXPOSE 8080

CMD ["pm2-runtime", "ecosystem.config.js"]

FROM node:18

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json yarn.lock ./

# Install dependencies
RUN yarn install --production

# Copy source code
COPY src/ ./src/
COPY config/ ./config/

EXPOSE 3000

CMD ["node", "src/server.js"]
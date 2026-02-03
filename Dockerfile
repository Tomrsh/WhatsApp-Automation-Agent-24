FROM node:20-slim
WORKDIR /app
# Sirf zaroori files copy karein
COPY package*.json ./
RUN npm install
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "index.js"]

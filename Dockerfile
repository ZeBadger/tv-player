# ---- build stage ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime stage ----
FROM node:22-alpine AS runtime
WORKDIR /app

# ffmpeg is required to transcode SD MPEG-2 video to browser-compatible H.264
RUN apk add --no-cache ffmpeg

COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY server.mjs ./server.mjs

ENV NODE_ENV=production
ENV PORT=80

EXPOSE 80
CMD ["node", "server.mjs"]

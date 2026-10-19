# StarNet 服务端 + 前端静态资源 一体镜像
# 构建上下文 = starnet/ 根目录（内含 server/ 与 client/）

# ---------- 阶段 1：构建前端 ----------
FROM node:22-alpine AS client-build
WORKDIR /build/client
COPY client/package*.json ./
RUN npm ci --no-audit --no-fund --fetch-retries=5 --fetch-retry-mintimeout=20000
COPY client/ ./
RUN npm run build

# ---------- 阶段 2：运行镜像 ----------
FROM node:22-alpine
WORKDIR /app/server
ENV NODE_ENV=production

# 服务端依赖（含 tsx 用于直接运行 TS）
COPY server/package*.json ./
RUN npm ci --no-audit --no-fund --fetch-retries=5 --fetch-retry-mintimeout=20000

COPY server/src ./src
# 目录布局须保持 /app/server + /app/client，index.ts 以 ../../client/dist 定位静态资源
COPY --from=client-build /build/client/dist /app/client/dist

EXPOSE 3000
CMD ["npx", "tsx", "src/index.ts"]

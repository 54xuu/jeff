# 构建上下文是仓库根目录：docker build -f apps/relay/Dockerfile .
# 默认走 DaoCloud 镜像，ECS 直连 Docker Hub 会超时。本机可覆盖：
#   docker build --build-arg NODE_IMAGE=node:22-alpine -f apps/relay/Dockerfile .
ARG NODE_IMAGE=docker.m.daocloud.io/library/node:22-alpine
FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY apps/relay/package.json ./package.json
RUN npm config set registry https://registry.npmmirror.com \
  && npm install
COPY apps/relay/src ./apps/relay/src
COPY packages/core/src/remote ./packages/core/src/remote
# ws 里有动态 require；打成 CJS，Node 才能加载。node:sqlite 留给运行时。
RUN ./node_modules/.bin/esbuild apps/relay/src/server.ts \
    --bundle --platform=node --format=cjs \
    --outfile=/out/server.cjs \
    --external:node:sqlite

FROM ${NODE_IMAGE}
WORKDIR /opt/jeff-relay
COPY --from=build /out/server.cjs ./server.cjs
ENV DATA_DIR=/data \
    PORT=9443 \
    TLS_CERT=/certs/cert.pem \
    TLS_KEY=/certs/key.pem
EXPOSE 9443
CMD ["node", "server.cjs"]

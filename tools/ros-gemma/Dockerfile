# Loopback worker (stub or llama-server HTTP adapter). Built with default `docker compose build ros-gemma`.
FROM rust:1.86-bookworm AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/ros-gemma /usr/local/bin/ros-gemma
EXPOSE 8787
ENV ROS_GEMMA_BIND=0.0.0.0:8787
# Compose also sets this; image default keeps `docker run` / mis-merged env from losing llama-server.
ENV LLAMA_CPP_SERVER_URL=http://llama-server:8080
USER nobody
CMD ["ros-gemma"]

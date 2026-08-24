FROM golang:1.24.8-bookworm AS builder

ARG MINIO_VERSION=RELEASE.2025-10-15T17-29-55Z
ENV CGO_ENABLED=0

RUN go install github.com/minio/minio@${MINIO_VERSION}

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /go/bin/minio /usr/local/bin/minio

EXPOSE 9000 9001
VOLUME ["/data"]
ENTRYPOINT ["minio"]
CMD ["server", "/data", "--console-address", ":9001"]

# syntax=docker/dockerfile:1.7
FROM golang:1.24-alpine AS build
WORKDIR /src
RUN apk add --no-cache ca-certificates
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
COPY web ./web
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/ib-account .

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/ib-account /usr/local/bin/ib-account
COPY --from=build --chown=nonroot:nonroot /src/web ./web
USER nonroot:nonroot
EXPOSE 8090
ENTRYPOINT ["/usr/local/bin/ib-account"]


ARG GO_IMAGE=golang:1.23-bookworm
FROM ${GO_IMAGE} AS build

WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/mandateflowd ./cmd/mandateflowd

FROM build AS test
RUN go test ./...

FROM build AS quality
RUN test -z "$(gofmt -l .)" \
    && go vet ./... \
    && go test -race ./...

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/mandateflowd /usr/local/bin/mandateflowd
COPY config/mixed-operations.v1.json /etc/mandateflow/mixed-operations.v1.json
USER 65532:65532
EXPOSE 3001 3002
ENTRYPOINT ["/usr/local/bin/mandateflowd"]

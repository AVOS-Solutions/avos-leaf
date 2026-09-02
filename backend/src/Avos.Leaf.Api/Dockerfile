FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

COPY Avos.Leaf.slnx ./
COPY src/Avos.Leaf.Api/Avos.Leaf.Api.csproj src/Avos.Leaf.Api/
COPY src/Avos.Leaf.Domain/Avos.Leaf.Domain.csproj src/Avos.Leaf.Domain/
COPY src/Avos.Leaf.Infrastructure/Avos.Leaf.Infrastructure.csproj src/Avos.Leaf.Infrastructure/
COPY tests/Avos.Leaf.Tests/Avos.Leaf.Tests.csproj tests/Avos.Leaf.Tests/
RUN dotnet restore src/Avos.Leaf.Api/Avos.Leaf.Api.csproj

COPY src/ src/
RUN dotnet publish src/Avos.Leaf.Api/Avos.Leaf.Api.csproj -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
RUN useradd --create-home appuser
COPY --from=build /app .
# Internal-TLS sidecar (see docker/Caddyfile) — terminates HTTPS on 8443 for container-to-container
# traffic within the Docker network, in front of the plain-HTTP Kestrel process on 8080. Same
# pattern as avos-vault/avos-quill/avos-slate's backend Dockerfiles.
COPY --from=caddy:2-alpine /usr/bin/caddy /usr/local/bin/caddy
COPY --chown=appuser:appuser src/Avos.Leaf.Api/docker/Caddyfile src/Avos.Leaf.Api/docker/entrypoint.sh docker/
RUN chmod +x docker/entrypoint.sh
ENV HOME=/home/appuser
USER appuser

EXPOSE 8080
EXPOSE 8443
# Left as an all-interfaces HTTP bind by default so the unmodified dev compose (docker-compose.yml,
# no Caddy involved) keeps working unchanged; docker-compose.prod.yml overrides this to bind
# loopback-only so 8080 is reachable only through the 8443 sidecar above.
ENV ASPNETCORE_URLS=http://+:8080
ENTRYPOINT ["/app/docker/entrypoint.sh"]

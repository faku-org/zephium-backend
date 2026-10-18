FROM postgres:18.4-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends pgbackrest ca-certificates && rm -rf /var/lib/apt/lists/*

# Versioned bootstrap/configuration travels with the image, not host-created bind directories.
COPY deploy/postgres/roles.sql /etc/zephium/roles.sql
COPY deploy/postgres/postgresql.conf.example /etc/postgresql/zephium.conf
COPY deploy/postgres/init-roles.sh /docker-entrypoint-initdb.d/10-zephium-roles.sh
RUN chmod 755 /docker-entrypoint-initdb.d/10-zephium-roles.sh

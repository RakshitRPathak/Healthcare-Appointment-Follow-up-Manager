#!/bin/sh
pg_lsclusters | grep -q online || pg_ctlcluster 16 main start
redis-cli ping >/dev/null 2>&1 || redis-server --daemonize yes >/dev/null
sleep 2
su postgres -c "psql -tc \"SELECT 1 FROM pg_roles WHERE rolname='ham'\"" | grep -q 1 || su postgres -c "psql -c \"CREATE USER ham WITH PASSWORD 'ham' SUPERUSER;\""
for db in ham ham_test; do su postgres -c "psql -tc \"SELECT 1 FROM pg_database WHERE datname='$db'\"" | grep -q 1 || su postgres -c "psql -c 'CREATE DATABASE $db OWNER ham;'"; done
pg_lsclusters | tail -1; redis-cli ping

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DROP TABLE IF EXISTS mcp_security_events;
DROP TABLE IF EXISTS mcp_gateway_runs;
DROP TABLE IF EXISTS mcp_endpoint_identities;
DROP TABLE IF EXISTS mcp_oauth_records;

-- #395: külső MCP-szerver mint connector-típus. Az eszközlista a meglévő
-- connector_spec_sources / connector_spec_versions táblákban él (spec_format = 'mcp_tools').
ALTER TYPE "ConnectorType" ADD VALUE IF NOT EXISTS 'mcp';

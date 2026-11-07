import type { FeatureFlagKey } from './registry'

/**
 * #1126: melyik MCP-eszköz melyik flag mögött van. Az itt felsorolt eszköz a flag nélküli cégnél nem
 * listázódik, és a hívása `mcp.tools.call.deny` eseménnyel elutasul.
 */
export const TOOL_FEATURE_FLAGS: Readonly<Record<string, FeatureFlagKey>> = {}

import packageMetadata from "../../package.json" with { type: "json" };

interface AgentHubPackageMetadata {
  version: string;
  agentHub: {
    protocolVersion: number;
    schemaVersion: number;
    minimumSourceProtocolVersion: number;
    minimumSourceSchemaVersion: number;
  };
}

const metadata = packageMetadata as AgentHubPackageMetadata;

export const AGENT_HUB_VERSION = metadata.version;
export const AGENT_HUB_PROTOCOL_VERSION = metadata.agentHub.protocolVersion;
export const AGENT_HUB_SCHEMA_VERSION = metadata.agentHub.schemaVersion;
export const AGENT_HUB_MINIMUM_SOURCE_PROTOCOL_VERSION = metadata.agentHub.minimumSourceProtocolVersion;
export const AGENT_HUB_MINIMUM_SOURCE_SCHEMA_VERSION = metadata.agentHub.minimumSourceSchemaVersion;

export const AGENT_HUB_RELEASE_OWNER = "lcx040126";
export const AGENT_HUB_RELEASE_REPOSITORY = "agent-hub";
export const AGENT_HUB_RELEASE_TAG_PREFIX = "v";
export const AGENT_HUB_UPDATE_MANIFEST_URL =
  "https://github.com/lcx040126/agent-hub/releases/latest/download/agent-hub-update.json";
export const AGENT_HUB_UPDATE_SIGNATURE_URL =
  "https://github.com/lcx040126/agent-hub/releases/latest/download/agent-hub-update.sig";

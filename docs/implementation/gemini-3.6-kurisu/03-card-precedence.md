# Card and deployment precedence

Environment configuration owns provider enablement, credentials, endpoints, timeouts, cache storage, and rollout switches. The character card owns persona, response-language fallback, entity vocabulary, pronunciation, voice identity/reference metadata, output protocol, lore, and display-model metadata. Card values never override infrastructure or secrets. When optional card data is absent, the registry supplies typed safe defaults.

ASR vocabulary is sent through the versioned HTTP headers, but the current Qwen backend reports `hotword_mode: unsupported`; it does not falsely claim decoder biasing.


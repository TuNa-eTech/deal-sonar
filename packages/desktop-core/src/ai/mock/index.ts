// Deterministic offline mock AI provider (port of crates/ai-bridge/src/adapters/mock).

export {
  MOCK_FAST_MODEL,
  MOCK_SMART_MODEL,
  MOCK_VERSION,
  MockAiProvider,
  discoverMockModels,
  type MockAiProviderOptions,
  type MockHandler,
  type MockQueuedResponse,
} from "./provider";

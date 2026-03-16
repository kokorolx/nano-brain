## ADDED Requirements

### Requirement: LLM provider implements LLMProvider interface
The `GitlabDuoLLMProvider` class SHALL implement the existing `LLMProvider` interface from `src/consolidation.ts`, providing a `complete(prompt)` method that returns `{ text: string; tokensUsed: number }` and an optional `model` property.

#### Scenario: Successful completion
- **WHEN** `complete()` is called with a valid prompt string
- **THEN** the provider SHALL send a POST request to `{endpoint}/v1/chat/completions` with `{ model, messages: [{ role: "user", content: prompt }], max_tokens: 4096, stream: false }` and return `{ text: choices[0].message.content, tokensUsed: usage.total_tokens }`

#### Scenario: Missing content in response
- **WHEN** the LLM response has no `choices[0].message.content`
- **THEN** the provider SHALL return `{ text: "", tokensUsed: 0 }`

#### Scenario: Missing token usage in response
- **WHEN** the LLM response has no `usage.total_tokens` field
- **THEN** the provider SHALL return `tokensUsed: 0` (default)

#### Scenario: HTTP error from endpoint
- **WHEN** the endpoint returns a non-2xx status code
- **THEN** the provider SHALL throw an Error with message including the status code and response body (truncated to 200 chars)

#### Scenario: Network timeout
- **WHEN** the endpoint does not respond within 60 seconds
- **THEN** the provider SHALL throw an Error with a timeout message

### Requirement: Factory function creates provider from config
A `createLLMProvider(config: ConsolidationConfig)` factory function SHALL create a `GitlabDuoLLMProvider` from the consolidation config fields.

#### Scenario: Valid config with all fields
- **WHEN** config has `endpoint`, `model`, and `apiKey` set
- **THEN** the factory SHALL return a configured `GitlabDuoLLMProvider` instance

#### Scenario: Config with apiKey from environment
- **WHEN** config has no `apiKey` but `CONSOLIDATION_API_KEY` env var is set
- **THEN** the factory SHALL use the env var value as the API key

#### Scenario: No apiKey available
- **WHEN** config has no `apiKey` and no `CONSOLIDATION_API_KEY` env var
- **THEN** the factory SHALL return `null`

#### Scenario: Default model
- **WHEN** config has no `model` set
- **THEN** the factory SHALL default to `duo-chat-haiku-4-5`

### Requirement: API key is never logged
The provider SHALL NOT include the API key in any log output. Only the endpoint URL and model name MAY be logged.

#### Scenario: Provider initialization logging
- **WHEN** the provider is created
- **THEN** the log output SHALL contain the endpoint URL and model but SHALL NOT contain the API key value

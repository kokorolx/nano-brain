## ADDED Requirements

### Requirement: Proxy calls time out after 30 seconds
`proxyGet` and `proxyPost` SHALL abort the HTTP request and throw an error if the server does not respond within 30 seconds. The timeout SHALL be implemented via `AbortSignal.timeout(timeoutMs)` with a default of 30,000ms.

#### Scenario: Server unreachable causes timeout error
- **WHEN** a CLI command calls `proxyPost` and the server does not respond within 30 seconds
- **THEN** the call SHALL throw an `AbortError` (or `TimeoutError`)
- **AND** the process SHALL NOT hang indefinitely

#### Scenario: Custom timeout can be passed
- **WHEN** a caller passes `timeoutMs` explicitly (e.g., 5000)
- **THEN** the abort SHALL fire after that many milliseconds

#### Scenario: Fast server response is unaffected
- **WHEN** the server responds within 1 second
- **THEN** the response SHALL be returned normally without any timeout interference

### Requirement: Proxy calls validate HTTP response status
`proxyGet` and `proxyPost` SHALL check `response.ok` and throw an error with the HTTP status code and status text if the response is not 2xx.

#### Scenario: Non-2xx response throws with status info
- **WHEN** the server returns HTTP 500 or any non-2xx status
- **THEN** the proxy function SHALL throw an `Error` with message containing the status code and status text
- **AND** the response body SHALL NOT be silently deserialized

#### Scenario: 2xx response is deserialized normally
- **WHEN** the server returns HTTP 200
- **THEN** the response JSON SHALL be returned as normal

### Requirement: Proxy error messages include actionable hints
When a proxy call fails due to connection refusal or timeout, the error message SHALL include a hint about setting the `NANO_BRAIN_HOST` environment variable.

#### Scenario: Connection refused includes NANO_BRAIN_HOST hint
- **WHEN** `proxyPost` fails because the server is not running
- **THEN** the error output SHALL mention `NANO_BRAIN_HOST` as a configuration option

## ADDED Requirements

### Requirement: Safe serve stop PID targeting

`nano-brain serve stop` SHALL avoid terminating unrelated host processes when using fallback port-based PID discovery.

#### Scenario: PID file points to unrelated process
- **WHEN** `serve.pid` exists but PID command line does not match nano-brain server process patterns
- **THEN** runtime SHALL skip killing that PID
- **AND** runtime SHALL continue to safe fallback checks

#### Scenario: Port fallback returns mixed PIDs
- **WHEN** fallback PID discovery returns multiple candidate PIDs
- **AND** one or more candidates are Docker/helper processes
- **THEN** runtime SHALL skip unsafe candidates
- **AND** runtime SHALL only signal validated safe candidates

#### Scenario: No safe PID candidates
- **WHEN** no validated nano-brain PID is found
- **THEN** runtime SHALL print "No running server found" with safety guidance
- **AND** runtime SHALL NOT send SIGTERM to unsafe candidates

#### Scenario: Force override
- **WHEN** user runs `nano-brain serve stop --force`
- **THEN** runtime MAY bypass safety filtering for fallback stop behavior
- **AND** runtime SHALL print a warning that force mode is active
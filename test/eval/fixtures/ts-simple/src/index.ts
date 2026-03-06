interface Request {
  body: unknown
  headers: Record<string, string>
}

interface Response {
  status: number
  data: unknown
}

interface ValidatedData {
  content: string
  timestamp: number
}

interface ProcessedResult {
  output: string
  metadata: Record<string, unknown>
}

export class Logger {
  private prefix: string

  constructor(prefix: string = "APP") {
    this.prefix = prefix
  }

  log(message: string): void {
    console.log(`[${this.prefix}] ${message}`)
  }

  error(message: string): void {
    this.log(`ERROR: ${message}`)
  }
}

const globalLogger = new Logger("GLOBAL")

function sanitizeString(input: string): string {
  return input.trim().replace(/[<>]/g, "")
}

function validateInput(data: unknown): ValidatedData {
  if (typeof data !== "object" || data === null) {
    globalLogger.error("Invalid input type")
    throw new Error("Invalid input")
  }
  const raw = (data as Record<string, unknown>).content
  const content = sanitizeString(String(raw ?? ""))
  return { content, timestamp: Date.now() }
}

function transformData(data: ValidatedData): ProcessedResult {
  return {
    output: data.content.toUpperCase(),
    metadata: { transformedAt: data.timestamp }
  }
}

function enrichData(result: ProcessedResult): ProcessedResult {
  globalLogger.log("Enriching data")
  return {
    ...result,
    metadata: { ...result.metadata, enriched: true }
  }
}

export function processData(data: ValidatedData): ProcessedResult {
  const transformed = transformData(data)
  const enriched = enrichData(transformed)
  return enriched
}

function formatResponse(result: ProcessedResult): Response {
  return {
    status: 200,
    data: result
  }
}

export function handleRequest(req: Request): Response {
  const validated = validateInput(req.body)
  const result = processData(validated)
  return formatResponse(result)
}

function createMockRequest(): Request {
  return {
    body: { content: "test data" },
    headers: { "content-type": "application/json" }
  }
}

export function initApp(): void {
  const logger = new Logger("INIT")
  logger.log("Application starting")
  const mockReq = createMockRequest()
  const response = handleRequest(mockReq)
  logger.log(`Response status: ${response.status}`)
}

export const processAsync = async (data: ValidatedData): Promise<ProcessedResult> => {
  globalLogger.log("Processing async")
  return processData(data)
}

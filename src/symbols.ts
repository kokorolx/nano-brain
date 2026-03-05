import type { SupportedLanguage } from './graph.js'

export interface ExtractedSymbol {
  type: string
  pattern: string
  operation: string
  filePath: string
  lineNumber: number
  rawExpression: string
}

export type SymbolType = 'redis_key' | 'pubsub_channel' | 'mysql_table' | 'api_endpoint' | 'http_call' | 'bull_queue'
export type SymbolOperation = 'read' | 'write' | 'publish' | 'subscribe' | 'define' | 'call' | 'produce' | 'consume'

function convertTemplateToWildcard(str: string): string {
  return str
    .replace(/\$\{[^}]+\}/g, '*')
    .replace(/#\{[^}]+\}/g, '*')
}

function extractFirstStringArg(match: string): string | null {
  const singleQuote = match.match(/['"]([^'"]+)['"]/)
  if (singleQuote) return singleQuote[1]
  const templateLiteral = match.match(/`([^`]+)`/)
  if (templateLiteral) return convertTemplateToWildcard(templateLiteral[1])
  return null
}

const REDIS_READ_METHODS = new Set([
  'get', 'hget', 'hgetall', 'hmget', 'sismember', 'smembers', 'scard',
  'lrange', 'llen', 'lindex', 'zrange', 'zrangebyscore', 'zscore', 'zcard',
  'exists', 'ttl', 'type', 'keys', 'scan', 'mget'
])

const REDIS_WRITE_METHODS = new Set([
  'set', 'hset', 'hmset', 'del', 'sadd', 'srem', 'lpush', 'rpush', 'lpop', 'rpop',
  'zadd', 'zrem', 'zincrby', 'incr', 'decr', 'incrby', 'decrby', 'expire', 'setex',
  'setnx', 'mset', 'hdel', 'hincrby', 'lset', 'ltrim'
])

function extractRedisSymbols(content: string, filePath: string, language: SupportedLanguage): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = []
  const lines = content.split('\n')

  const jsPatterns = [
    /(?:redis|redisClient|client|cache)\s*\.\s*(get|set|hget|hset|hgetall|hmget|hmset|del|sadd|srem|sismember|smembers|scard|lpush|rpush|lpop|rpop|lrange|llen|lindex|zadd|zrem|zrange|zrangebyscore|zscore|zcard|zincrby|exists|ttl|type|keys|scan|mget|incr|decr|incrby|decrby|expire|setex|setnx|mset|hdel|hincrby|lset|ltrim)\s*\(\s*(['"`][^'"`]*['"`]|`[^`]*`)/gi,
    /await\s+(?:redis|redisClient|client|cache)\s*\.\s*(get|set|hget|hset|hgetall|hmget|hmset|del|sadd|srem|sismember|smembers|scard|lpush|rpush|lpop|rpop|lrange|llen|lindex|zadd|zrem|zrange|zrangebyscore|zscore|zcard|zincrby|exists|ttl|type|keys|scan|mget|incr|decr|incrby|decrby|expire|setex|setnx|mset|hdel|hincrby|lset|ltrim)\s*\(\s*(['"`][^'"`]*['"`]|`[^`]*`)/gi,
  ]

  const rubyPatterns = [
    /(?:Redis\.current|redis|REDIS|\$redis)\s*\.\s*(get|set|hget|hset|hgetall|hmget|hmset|del|sadd|srem|sismember|smembers|scard|lpush|rpush|lpop|rpop|lrange|llen|lindex|zadd|zrem|zrange|zrangebyscore|zscore|zcard|zincrby|exists|ttl|type|keys|scan|mget|incr|decr|incrby|decrby|expire|setex|setnx|mset|hdel|hincrby|lset|ltrim)\s*\(\s*(['"][^'"]*['"]|"[^"]*#\{[^}]*\}[^"]*")/gi,
  ]

  const pythonPatterns = [
    /(?:redis|r|client|cache)\s*\.\s*(get|set|hget|hset|hgetall|hmget|hmset|delete|sadd|srem|sismember|smembers|scard|lpush|rpush|lpop|rpop|lrange|llen|lindex|zadd|zrem|zrange|zrangebyscore|zscore|zcard|zincrby|exists|ttl|type|keys|scan|mget|incr|decr|incrby|decrby|expire|setex|setnx|mset|hdel|hincrby|lset|ltrim)\s*\(\s*(['"][^'"]*['"]|f['"][^'"]*['"])/gi,
  ]

  const patterns = language === 'ruby' ? rubyPatterns : language === 'python' ? pythonPatterns : jsPatterns

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum]
    for (const pattern of patterns) {
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(line)) !== null) {
        const method = match[1].toLowerCase()
        const keyArg = match[2]
        const key = extractFirstStringArg(keyArg)
        if (!key) continue

        const normalizedKey = convertTemplateToWildcard(key)
        const operation = REDIS_READ_METHODS.has(method) ? 'read' : REDIS_WRITE_METHODS.has(method) ? 'write' : 'read'

        symbols.push({
          type: 'redis_key',
          pattern: normalizedKey,
          operation,
          filePath,
          lineNumber: lineNum + 1,
          rawExpression: match[0].trim(),
        })
      }
    }
  }

  return symbols
}

function extractPubSubSymbols(content: string, filePath: string, language: SupportedLanguage): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = []
  const lines = content.split('\n')

  const publishPatterns = [
    /(?:redis|redisClient|client|pubsub)\s*\.\s*publish\s*\(\s*(['"`][^'"`]*['"`]|`[^`]*`)/gi,
    /(?:Redis\.current|redis|REDIS|\$redis)\s*\.\s*publish\s*\(\s*(['"][^'"]*['"])/gi,
  ]

  const subscribePatterns = [
    /(?:redis|redisClient|client|pubsub)\s*\.\s*subscribe\s*\(\s*(['"`][^'"`]*['"`]|`[^`]*`)/gi,
    /(?:redis|redisClient|client|pubsub)\s*\.\s*psubscribe\s*\(\s*(['"`][^'"`]*['"`]|`[^`]*`)/gi,
    /(?:Redis\.current|redis|REDIS|\$redis)\s*\.\s*subscribe\s*\(\s*(['"][^'"]*['"])/gi,
    /\.on\s*\(\s*['"]message['"]\s*,/gi,
  ]

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum]

    for (const pattern of publishPatterns) {
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(line)) !== null) {
        const channelArg = match[1]
        const channel = extractFirstStringArg(channelArg)
        if (!channel) continue

        symbols.push({
          type: 'pubsub_channel',
          pattern: convertTemplateToWildcard(channel),
          operation: 'publish',
          filePath,
          lineNumber: lineNum + 1,
          rawExpression: match[0].trim(),
        })
      }
    }

    for (const pattern of subscribePatterns) {
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(line)) !== null) {
        if (match[0].includes('.on(')) {
          symbols.push({
            type: 'pubsub_channel',
            pattern: '*',
            operation: 'subscribe',
            filePath,
            lineNumber: lineNum + 1,
            rawExpression: match[0].trim(),
          })
          continue
        }
        const channelArg = match[1]
        const channel = extractFirstStringArg(channelArg)
        if (!channel) continue

        symbols.push({
          type: 'pubsub_channel',
          pattern: convertTemplateToWildcard(channel),
          operation: 'subscribe',
          filePath,
          lineNumber: lineNum + 1,
          rawExpression: match[0].trim(),
        })
      }
    }
  }

  return symbols
}

function extractMySQLSymbols(content: string, filePath: string, language: SupportedLanguage): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = []
  const lines = content.split('\n')

  const sqlSelectPattern = /SELECT\s+[\s\S]*?\s+FROM\s+[`"]?(\w+)[`"]?/gi
  const sqlInsertPattern = /INSERT\s+INTO\s+[`"]?(\w+)[`"]?/gi
  const sqlUpdatePattern = /UPDATE\s+[`"]?(\w+)[`"]?/gi
  const sqlDeletePattern = /DELETE\s+FROM\s+[`"]?(\w+)[`"]?/gi
  const sqlJoinPattern = /JOIN\s+[`"]?(\w+)[`"]?/gi

  const prismaPattern = /prisma\s*\.\s*(\w+)\s*\.\s*(findMany|findFirst|findUnique|create|createMany|update|updateMany|delete|deleteMany|upsert|count|aggregate|groupBy)/gi
  const sequelizeDefinePattern = /(?:sequelize|Sequelize)\s*\.\s*define\s*\(\s*['"](\w+)['"]/gi
  const entityPattern = /@Entity\s*\(\s*['"](\w+)['"]\s*\)/gi

  const railsModelPattern = /class\s+(\w+)\s*<\s*(?:ApplicationRecord|ActiveRecord::Base)/gi

  function camelToSnake(str: string): string {
    return str.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()
  }

  function pluralize(word: string): string {
    if (word.endsWith('y') && !/[aeiou]y$/i.test(word)) {
      return word.slice(0, -1) + 'ies'
    }
    if (word.endsWith('s') || word.endsWith('x') || word.endsWith('ch') || word.endsWith('sh')) {
      return word + 'es'
    }
    return word + 's'
  }

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum]

    for (const pattern of [sqlSelectPattern]) {
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(line)) !== null) {
        symbols.push({
          type: 'mysql_table',
          pattern: match[1].toLowerCase(),
          operation: 'read',
          filePath,
          lineNumber: lineNum + 1,
          rawExpression: match[0].trim(),
        })
      }
    }

    for (const pattern of [sqlInsertPattern, sqlUpdatePattern, sqlDeletePattern]) {
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(line)) !== null) {
        symbols.push({
          type: 'mysql_table',
          pattern: match[1].toLowerCase(),
          operation: 'write',
          filePath,
          lineNumber: lineNum + 1,
          rawExpression: match[0].trim(),
        })
      }
    }

    sqlJoinPattern.lastIndex = 0
    let joinMatch
    while ((joinMatch = sqlJoinPattern.exec(line)) !== null) {
      symbols.push({
        type: 'mysql_table',
        pattern: joinMatch[1].toLowerCase(),
        operation: 'read',
        filePath,
        lineNumber: lineNum + 1,
        rawExpression: joinMatch[0].trim(),
      })
    }

    if (language === 'js' || language === 'ts') {
      prismaPattern.lastIndex = 0
      let prismaMatch
      while ((prismaMatch = prismaPattern.exec(line)) !== null) {
        const modelName = prismaMatch[1]
        const method = prismaMatch[2].toLowerCase()
        const tableName = camelToSnake(modelName)
        const isRead = ['findmany', 'findfirst', 'findunique', 'count', 'aggregate', 'groupby'].includes(method)

        symbols.push({
          type: 'mysql_table',
          pattern: tableName,
          operation: isRead ? 'read' : 'write',
          filePath,
          lineNumber: lineNum + 1,
          rawExpression: prismaMatch[0].trim(),
        })
      }

      sequelizeDefinePattern.lastIndex = 0
      let seqMatch
      while ((seqMatch = sequelizeDefinePattern.exec(line)) !== null) {
        symbols.push({
          type: 'mysql_table',
          pattern: seqMatch[1].toLowerCase(),
          operation: 'define',
          filePath,
          lineNumber: lineNum + 1,
          rawExpression: seqMatch[0].trim(),
        })
      }

      entityPattern.lastIndex = 0
      let entityMatch
      while ((entityMatch = entityPattern.exec(line)) !== null) {
        symbols.push({
          type: 'mysql_table',
          pattern: entityMatch[1].toLowerCase(),
          operation: 'define',
          filePath,
          lineNumber: lineNum + 1,
          rawExpression: entityMatch[0].trim(),
        })
      }
    }

    if (language === 'ruby') {
      railsModelPattern.lastIndex = 0
      let railsMatch
      while ((railsMatch = railsModelPattern.exec(line)) !== null) {
        const modelName = railsMatch[1]
        const tableName = pluralize(camelToSnake(modelName))

        symbols.push({
          type: 'mysql_table',
          pattern: tableName,
          operation: 'define',
          filePath,
          lineNumber: lineNum + 1,
          rawExpression: railsMatch[0].trim(),
        })
      }
    }
  }

  return symbols
}

function extractAPIEndpointSymbols(content: string, filePath: string, language: SupportedLanguage): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = []
  const lines = content.split('\n')

  const expressPatterns = [
    /(?:app|router)\s*\.\s*(get|post|put|patch|delete|options|head)\s*\(\s*(['"`][^'"`]*['"`]|`[^`]*`)/gi,
  ]

  const nestPatterns = [
    /@(Get|Post|Put|Patch|Delete|Options|Head)\s*\(\s*(['"`][^'"`]*['"`])?\s*\)/gi,
  ]

  const railsRoutePatterns = [
    /^\s*(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/gim,
    /^\s*resources\s+:(\w+)/gim,
  ]

  let controllerPrefix = ''
  const controllerMatch = content.match(/@Controller\s*\(\s*['"`]([^'"`]*)['"]\s*\)/i)
  if (controllerMatch) {
    controllerPrefix = controllerMatch[1]
  }

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum]

    if (language === 'js' || language === 'ts') {
      for (const pattern of expressPatterns) {
        pattern.lastIndex = 0
        let match
        while ((match = pattern.exec(line)) !== null) {
          const pathArg = match[2]
          const path = extractFirstStringArg(pathArg)
          if (!path) continue

          symbols.push({
            type: 'api_endpoint',
            pattern: convertTemplateToWildcard(path),
            operation: 'define',
            filePath,
            lineNumber: lineNum + 1,
            rawExpression: match[0].trim(),
          })
        }
      }

      for (const pattern of nestPatterns) {
        pattern.lastIndex = 0
        let match
        while ((match = pattern.exec(line)) !== null) {
          const pathArg = match[2] || "''"
          const path = extractFirstStringArg(pathArg) || ''
          const fullPath = controllerPrefix ? `${controllerPrefix}${path ? '/' + path : ''}` : path || '/'

          symbols.push({
            type: 'api_endpoint',
            pattern: fullPath.replace(/\/+/g, '/'),
            operation: 'define',
            filePath,
            lineNumber: lineNum + 1,
            rawExpression: match[0].trim(),
          })
        }
      }
    }

    if (language === 'ruby') {
      for (const pattern of railsRoutePatterns) {
        pattern.lastIndex = 0
        let match
        while ((match = pattern.exec(line)) !== null) {
          if (match[0].includes('resources')) {
            const resourceName = match[1]
            symbols.push({
              type: 'api_endpoint',
              pattern: `/${resourceName}`,
              operation: 'define',
              filePath,
              lineNumber: lineNum + 1,
              rawExpression: match[0].trim(),
            })
          } else {
            const path = match[2]
            symbols.push({
              type: 'api_endpoint',
              pattern: path,
              operation: 'define',
              filePath,
              lineNumber: lineNum + 1,
              rawExpression: match[0].trim(),
            })
          }
        }
      }
    }
  }

  return symbols
}

function extractHTTPCallSymbols(content: string, filePath: string, language: SupportedLanguage): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = []
  const lines = content.split('\n')

  const jsPatterns = [
    /axios\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*(['"`][^'"`]*['"`]|`[^`]*`)/gi,
    /fetch\s*\(\s*(['"`][^'"`]*['"`]|`[^`]*`)/gi,
    /(?:http|https)\s*\.\s*(get|post|put|patch|delete|request)\s*\(\s*(['"`][^'"`]*['"`]|`[^`]*`)/gi,
  ]

  const pythonPatterns = [
    /requests\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*(['"][^'"]*['"]|f['"][^'"]*['"])/gi,
    /(?:http|urllib)\s*\.\s*request\s*\(\s*['"](\w+)['"]\s*,\s*(['"][^'"]*['"])/gi,
  ]

  const rubyPatterns = [
    /Net::HTTP\s*\.\s*(get|post|put|patch|delete)\s*\(\s*(?:URI\s*\(\s*)?(['"][^'"]*['"])/gi,
    /(?:HTTParty|Faraday|RestClient)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*(['"][^'"]*['"])/gi,
  ]

  const patterns = language === 'ruby' ? rubyPatterns : language === 'python' ? pythonPatterns : jsPatterns

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum]

    for (const pattern of patterns) {
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(line)) !== null) {
        const urlArg = match[2] || match[1]
        const url = extractFirstStringArg(urlArg)
        if (!url) continue

        symbols.push({
          type: 'http_call',
          pattern: convertTemplateToWildcard(url),
          operation: 'call',
          filePath,
          lineNumber: lineNum + 1,
          rawExpression: match[0].trim(),
        })
      }
    }
  }

  return symbols
}

function extractBullQueueSymbols(content: string, filePath: string, language: SupportedLanguage): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = []
  const lines = content.split('\n')

  const jsPatterns = [
    /new\s+(?:Bull|Queue)\s*\(\s*(['"`][^'"`]*['"`])/gi,
    /(?:queue|bullQueue)\s*\.\s*add\s*\(/gi,
    /(?:queue|bullQueue)\s*\.\s*process\s*\(/gi,
  ]

  const rubyPatterns = [
    /sidekiq_options\s+queue:\s*['":]+(\w+)/gi,
    /perform_async/gi,
    /class\s+\w+\s*\n\s*include\s+Sidekiq::Worker/gi,
  ]

  let currentQueueName: string | null = null

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum]

    if (language === 'js' || language === 'ts') {
      const queueConstructor = /new\s+(?:Bull|Queue)\s*\(\s*(['"`])([^'"`]+)\1/i.exec(line)
      if (queueConstructor) {
        currentQueueName = queueConstructor[2]
        symbols.push({
          type: 'bull_queue',
          pattern: currentQueueName,
          operation: 'define',
          filePath,
          lineNumber: lineNum + 1,
          rawExpression: queueConstructor[0].trim(),
        })
      }

      if (/(?:queue|bullQueue)\s*\.\s*add\s*\(/i.test(line) && currentQueueName) {
        symbols.push({
          type: 'bull_queue',
          pattern: currentQueueName,
          operation: 'produce',
          filePath,
          lineNumber: lineNum + 1,
          rawExpression: line.trim(),
        })
      }

      if (/(?:queue|bullQueue)\s*\.\s*process\s*\(/i.test(line) && currentQueueName) {
        symbols.push({
          type: 'bull_queue',
          pattern: currentQueueName,
          operation: 'consume',
          filePath,
          lineNumber: lineNum + 1,
          rawExpression: line.trim(),
        })
      }
    }

    if (language === 'ruby') {
      const sidekiqOptions = /sidekiq_options\s+queue:\s*['":]+(\w+)/i.exec(line)
      if (sidekiqOptions) {
        currentQueueName = sidekiqOptions[1]
        symbols.push({
          type: 'bull_queue',
          pattern: currentQueueName,
          operation: 'define',
          filePath,
          lineNumber: lineNum + 1,
          rawExpression: sidekiqOptions[0].trim(),
        })
      }

      if (/perform_async/i.test(line) && currentQueueName) {
        symbols.push({
          type: 'bull_queue',
          pattern: currentQueueName,
          operation: 'produce',
          filePath,
          lineNumber: lineNum + 1,
          rawExpression: line.trim(),
        })
      }
    }
  }

  return symbols
}

export function extractSymbols(
  filePath: string,
  content: string,
  language: SupportedLanguage
): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = []

  symbols.push(...extractRedisSymbols(content, filePath, language))
  symbols.push(...extractPubSubSymbols(content, filePath, language))
  symbols.push(...extractMySQLSymbols(content, filePath, language))
  symbols.push(...extractAPIEndpointSymbols(content, filePath, language))
  symbols.push(...extractHTTPCallSymbols(content, filePath, language))
  symbols.push(...extractBullQueueSymbols(content, filePath, language))

  return symbols
}

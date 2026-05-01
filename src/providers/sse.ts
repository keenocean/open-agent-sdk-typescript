export async function* readSseData(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventLines: string[] = []

  const emitLine = (line: string): string | undefined => {
    if (line === '') {
      if (eventLines.length === 0) return undefined
      const data = eventLines.join('\n')
      eventLines = []
      return data
    }

    if (line.startsWith('data:')) {
      eventLines.push(line.slice(5).trimStart())
    }

    return undefined
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const data = emitLine(line)
        if (data !== undefined) yield data
      }
    }

    buffer += decoder.decode()
    if (buffer) {
      const lines = buffer.split(/\r?\n/)
      for (const line of lines) {
        const data = emitLine(line)
        if (data !== undefined) yield data
      }
    }

    if (eventLines.length > 0) {
      yield eventLines.join('\n')
    }
  } finally {
    reader.releaseLock()
  }
}

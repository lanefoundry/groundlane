export async function voterHash(ip: string): Promise<string> {
  const dailySalt = new Date().toISOString().slice(0, 10)
  const data = new TextEncoder().encode(`${ip}:${dailySalt}`)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function generateId(): string {
  return crypto.randomUUID()
}

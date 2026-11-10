export function jevKey(): string {
  return process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY || "";
}

export function deepgramKey(): string {
  return process.env.DEEPGRAM_API_KEY || "";
}

export function vapiKey(): string {
  return process.env.VAPI_API_KEY || "";
}

export function detectChallenge(title: string, bodyStart: string): boolean {
  const content = `${title}\n${bodyStart}`.toLowerCase();
  return /just a moment|attention required|checking your browser|verify you are human|performing security verification/.test(content);
}

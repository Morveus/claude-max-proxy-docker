export function openaiToCli(body) {
  return { prompt: "p", model: body.model || "sonnet", sessionId: body.sessionId };
}

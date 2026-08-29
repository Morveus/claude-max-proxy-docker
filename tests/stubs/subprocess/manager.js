import { EventEmitter } from "events";
export class ClaudeSubprocess extends EventEmitter {
  constructor() { super(); globalThis.__spawns = (globalThis.__spawns || 0) + 1; }
  async start() {
    const step = (globalThis.__scenario || []).shift() || { type: "ok", text: "default" };
    setTimeout(() => {
      if (step.type === "hardError") { this.emit("error", new Error("spawn boom")); this.emit("close", 1); return; }
      if (step.type === "timeout") { this.emit("error", new Error("Request timed out after 300000ms")); this.emit("close", 1); return; }
      if (step.type === "transient") {
        this.emit("result", { type: "result", is_error: true, result: "Failed to authenticate: OAuth session expired and could not be refreshed", usage: { input_tokens: 0, output_tokens: 0 } });
      } else if (step.type === "failedOther") {
        this.emit("result", { type: "result", is_error: true, result: "Invalid model name", usage: { input_tokens: 0, output_tokens: 0 } });
      } else if (step.type === "okTalksAboutAuth") {
        this.emit("assistant", { message: { model: "claude-sonnet-4-5" } });
        this.emit("result", { type: "result", is_error: false, result: "Pour corriger, run /login puis Failed to authenticate apparait", usage: { input_tokens: 12, output_tokens: 30 }, modelUsage: { "claude-sonnet-4-5": {} } });
      } else {
        this.emit("assistant", { message: { model: "claude-sonnet-4-5" } });
        if (step.stream) this.emit("content_delta", { event: { delta: { text: step.text } } });
        this.emit("result", { type: "result", is_error: false, result: step.text, usage: { input_tokens: 5, output_tokens: 9 }, modelUsage: { "claude-sonnet-4-5": {} } });
      }
      this.emit("close", 0);
    }, 1);
  }
  kill() { globalThis.__kills = (globalThis.__kills || 0) + 1; }
}

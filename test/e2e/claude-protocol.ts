// Claude Code's side of the Agent SDK's stream-json protocol, for fixtures that stand in for it:
// the SDK sends an initialize request, then the prompt as one user message, and reads one result.
// `answer` gets the prompt and returns the result's fields (structured_output, usage, total_cost_usd…).

const send = (message: unknown) => console.log(JSON.stringify(message))

export const serveClaude = async (answer: (prompt: string) => Record<string, unknown> | Promise<Record<string, unknown>>) => {
  for await (const line of console) {
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.type === "control_request" && message.request?.subtype === "initialize") {
      send({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: message.request_id,
          response: {
            commands: [],
            agents: [],
            output_style: "default",
            available_output_styles: [],
            models: [],
            account: { email: "fixture@acme.com", tokenSource: "claude.ai" },
            claude_code_version: "1.0",
          },
        },
      })
    }
    if (message.type === "user") {
      const content: string | ReadonlyArray<{ readonly text?: string }> = message.message.content
      const prompt = typeof content === "string" ? content : content.map((block) => block.text ?? "").join("")
      send({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "",
        duration_ms: 0,
        duration_api_ms: 0,
        num_turns: 1,
        stop_reason: "end_turn",
        modelUsage: {},
        permission_denials: [],
        uuid: crypto.randomUUID(),
        session_id: "fixture",
        ...(await answer(prompt)),
      })
    }
  }
}

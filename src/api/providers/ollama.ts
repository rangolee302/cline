// src/api/providers/ollama.ts

import type { Anthropic } from "@anthropic-ai/sdk"
import { type Config, type Message, Ollama, type ToolCall } from "ollama"

import { ApiHandlerOptions, type ModelInfo, openAiModelInfoSaneDefaults } from "../../shared/api"

import type { ApiHandler } from "../"
import { withRetry } from "../retry"
import { convertToOllamaMessages } from "../transform/ollama-format"
import type { ApiStream } from "../transform/stream"

interface OllamaHandlerOptions {
	ollamaBaseUrl?: string
	ollamaApiKey?: string
	ollamaModelId?: string
	ollamaApiOptionsCtxNum?: string
	requestTimeoutMs?: number
	// If you want to force-enable thinking for models that support it,
	// set this to true. Most Harmony/Reasoning models return `thinking` by default.
	think?: boolean
}

// Harmony-style message (Ollama adds `thinking` alongside `content`)
type HarmonyMessage = {
	role: "system" | "user" | "assistant" | string
	content: string
	images?: Uint8Array[] | string[]
	tool_calls?: ToolCall[]
	thinking?: string
}

const DEFAULT_CONTEXT_WINDOW = 32768

export class OllamaHandler implements ApiHandler {
	private options: OllamaHandlerOptions
	private client: Ollama | undefined

	constructor(options: OllamaHandlerOptions) {
		const ollamaApiOptionsCtxNum = (options.ollamaApiOptionsCtxNum ?? DEFAULT_CONTEXT_WINDOW).toString()
		this.options = { ...options, ollamaApiOptionsCtxNum }
	}

	private ensureClient(): Ollama {
		if (!this.client) {
			const clientOptions: Partial<Config> = {
				host: this.options.ollamaBaseUrl || "http://localhost:11434",
			}
			if (this.options.ollamaApiKey) {
				clientOptions.headers = {
					Authorization: `Bearer ${this.options.ollamaApiKey}`,
				}
			}
			this.client = new Ollama(clientOptions)
		}
		return this.client
	}

	@withRetry({ retryAllErrors: true })
	async *createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
		const client = this.ensureClient()

		const ollamaMessages: Message[] = [{ role: "system", content: systemPrompt }, ...convertToOllamaMessages(messages)]

		// Timeout guard (mirrors other providers)
		const timeoutMs = this.options.requestTimeoutMs || 30_000
		const timeoutPromise = new Promise<never>((_, reject) => {
			setTimeout(
				() => reject(new Error(`Ollama request timed out after ${Math.floor(timeoutMs / 1000)} seconds`)),
				timeoutMs,
			)
		})

		try {
			// Start streaming chat
			// const apiPromise = client.chat({
			// 	model: this.getModel().id,
			// 	messages: ollamaMessages,
			// 	stream: true,
			// 	// Note: num_ctx is respected by the server; Cline uses getModel().info.contextWindow
			// 	// for planning. We still send this to the server explicitly.
			// 	options: {
			// 		num_ctx: Number(this.options.ollamaApiOptionsCtxNum),
			// 	},
			// 	// Optional: pass think=true for models that support "Thinking" (Harmony-style)
			// 	// Many Harmony models already return `thinking` by default, so this is safe to omit.
			// 	...(this.options.think ? { think: true } : {}),
			// })
			const targetUrl = this.options.ollamaBaseUrl || "http://localhost:11434"
			const apiPromise = await fetch(targetUrl + "/api/chat", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: this.getModel().id,
					messages: ollamaMessages,
					stream: true,
				}),
			})
			console.log(`$Sending Message`)
			const response = (await Promise.race([apiPromise, timeoutPromise])) as Awaited<typeof apiPromise>
			console.log(`$Received Response`)

			if (!response.ok || !response.body) {
				console.error("HTTP error", response.status, await response.text())
				return
			}

			const reader = response.body.getReader()
			const decoder = new TextDecoder()
			let buffer = ""
			let isDone = false

			while (!isDone) {
				const { value, done: readerDone } = await reader.read()
				if (readerDone) break
				buffer += decoder.decode(value, { stream: true })

				const lines = buffer.split("\n")
				buffer = lines.pop() || ""

				for (const line of lines) {
					if (!line.trim()) continue

					let chunk
					try {
						chunk = JSON.parse(line)
					} catch (err) {
						console.error("JSON parse error:", err, line)
						continue
					}

					const msg = chunk.message
					console.log("Received chunk:", chunk)

					if (msg.thinking) {
						console.log("Thinking:", msg.thinking)
						// send reasoning downstream
						yield {
							type: "reasoning",
							reasoning: msg.thinking,
						}
					}

					if (msg.content) {
						console.log("Content:", msg.content)
						// send content downstream
						yield {
							type: "text",
							text: msg.content,
						}
					}

					if (chunk.done) {
						console.log("Stream complete (done=true).")
						isDone = true
						break
					}
				}
			}
		} catch (error: any) {
			// Normalize timeouts
			if (typeof error?.message === "string" && error.message.includes("timed out")) {
				throw new Error(`Ollama request timed out after ${Math.floor(timeoutMs / 1000)} seconds`)
			}
			const statusCode = error?.status || error?.statusCode
			const errorMessage = error?.message || "Unknown error"
			console.error(`Ollama API error (${statusCode || "unknown"}): ${errorMessage}`)
			throw error
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		const ctx = parseInt(this.options.ollamaApiOptionsCtxNum ?? "", 10)
		return {
			id: this.options.ollamaModelId || "",
			info: {
				...openAiModelInfoSaneDefaults,
				// Let Cline plan based on the actual Ollama ctx
				contextWindow: Number.isFinite(ctx) ? ctx : DEFAULT_CONTEXT_WINDOW,
			},
		}
	}
}

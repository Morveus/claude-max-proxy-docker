/**
 * API Route Handlers (version patchée Morveus)
 *
 * Ajout par rapport à l'upstream : retry automatique des échecs transitoires de
 * la CLI Claude Code, et surtout arrêt du masquage de ces échecs.
 *
 * Contexte (29/08/2026) : quand la CLI n'arrive pas à rafraîchir sa session,
 * elle émet un message `result` dont le champ `result` vaut
 *   « Failed to authenticate: OAuth session expired and could not be refreshed »
 * avec `is_error: true` et un usage à zéro. L'upstream recopiait ce texte tel
 * quel dans `choices[0].message.content` et répondait **HTTP 200**, donc
 * indistinguable d'une vraie réponse du modèle : les appelants croyaient avoir
 * reçu une réponse, et les humains en déduisaient à tort que le token OAuth du
 * secret avait expiré. L'incident se résout seul en quelques secondes.
 *
 * Deux corrections :
 *   1. Détection de ces résultats et nouvelle tentative (backoff court).
 *   2. Si toutes les tentatives échouent, réponse en erreur franche (502 en
 *      non-streaming, chunk `error` en streaming) au lieu d'un faux 200.
 */
import { v4 as uuidv4 } from "uuid";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import { openaiToCli } from "../adapter/openai-to-cli.js";
import { cliResultToOpenai, createDoneChunk, } from "../adapter/cli-to-openai.js";

/**
 * Motifs d'échec transitoire de la CLI. Volontairement restreint aux pannes qui
 * se résolvent seules : pas de quota dépassé ni d'erreur de requête, qui ne
 * gagnent rien à être retentés.
 */
const TRANSIENT_PATTERNS = [
    /OAuth session expired/i,
    /could not be refreshed/i,
    /Failed to authenticate/i,
    /Please run \/login/i,
    /Login expired/i,
    /authentication_error/i,
    /\boverloaded\b/i,
    /Internal server error/i,
];

/** Attentes avant chaque nouvelle tentative. La longueur fixe le nombre de retries. */
const RETRY_DELAYS_MS = parseRetryDelays(process.env.PROXY_RETRY_DELAYS_MS) ?? [1000, 3000, 7000];

function parseRetryDelays(raw) {
    if (!raw)
        return null;
    const parsed = raw
        .split(",")
        .map((v) => parseInt(v.trim(), 10))
        .filter((v) => Number.isFinite(v) && v >= 0);
    return parsed.length > 0 ? parsed : null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Un `result` qui n'a consommé aucun token n'est pas une réponse du modèle.
 * Ce garde-fou évite de retenter une vraie réponse qui parlerait d'authentification.
 */
function hasNoUsage(result) {
    const usage = result.usage || {};
    return !(usage.input_tokens > 0 || usage.output_tokens > 0);
}

function isTransientResult(result) {
    if (!result)
        return false;
    const text = typeof result.result === "string" ? result.result : "";
    if (!text)
        return false;
    if (!(result.is_error === true || hasNoUsage(result)))
        return false;
    return TRANSIENT_PATTERNS.some((re) => re.test(text));
}

/**
 * Un échec franc de la CLI : elle a signalé une erreur et n'a produit aucun
 * token. Le texte associé est un message d'erreur, jamais une réponse du
 * modèle, et ne doit donc pas partir en HTTP 200.
 */
function isFailedResult(result) {
    if (!result)
        return true;
    return result.is_error === true && hasNoUsage(result);
}

/**
 * Un plantage de la CLI vaut une nouvelle tentative, sauf le dépassement de
 * délai : le timeout par tentative est de 5 minutes, le rejouer trois fois
 * ferait patienter le client vingt minutes pour rien.
 */
function isRetryableHardError(error) {
    if (!error)
        return false;
    return !/timed out/i.test(error.message || "");
}

function transientReason(result) {
    const text = typeof result?.result === "string" ? result.result : "";
    return text.slice(0, 200) || "no result emitted";
}

/**
 * Handle POST /v1/chat/completions
 *
 * Main endpoint for chat requests, supports both streaming and non-streaming
 */
export async function handleChatCompletions(req, res) {
    const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
    const body = req.body;
    const stream = body.stream === true;
    try {
        // Validate request
        if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
            res.status(400).json({
                error: {
                    message: "messages is required and must be a non-empty array",
                    type: "invalid_request_error",
                    code: "invalid_messages",
                },
            });
            return;
        }
        // Convert to CLI input format
        const cliInput = openaiToCli(body);
        if (stream) {
            await handleStreamingResponse(req, res, cliInput, requestId);
        }
        else {
            await handleNonStreamingResponse(res, cliInput, requestId);
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error("[handleChatCompletions] Error:", message);
        if (!res.headersSent) {
            res.status(500).json({
                error: {
                    message,
                    type: "server_error",
                    code: null,
                },
            });
        }
    }
}

/**
 * Lance une fois la CLI et collecte le résultat.
 *
 * `onDelta` est appelé pour chaque fragment de texte. Il renvoie `true` si le
 * fragment a bien été transmis au client : dès qu'un fragment est parti, la
 * requête n'est plus rejouable.
 */
function runAttempt(cliInput, { onDelta, onAssistant, onStart } = {}) {
    return new Promise((resolve) => {
        const subprocess = new ClaudeSubprocess();
        onStart?.(subprocess);
        let result = null;
        let hardError = null;
        let emitted = false;
        let settled = false;
        const finish = () => {
            if (settled)
                return;
            settled = true;
            resolve({ result, hardError, emitted, subprocess });
        };
        if (onDelta) {
            subprocess.on("content_delta", (event) => {
                const text = event.event.delta?.text || "";
                if (!text)
                    return;
                if (onDelta(text))
                    emitted = true;
            });
        }
        if (onAssistant) {
            subprocess.on("assistant", (message) => onAssistant(message));
        }
        subprocess.on("result", (r) => {
            result = r;
        });
        subprocess.on("error", (error) => {
            hardError = error;
            finish();
        });
        subprocess.on("close", () => finish());
        subprocess
            .start(cliInput.prompt, {
            model: cliInput.model,
            sessionId: cliInput.sessionId,
        })
            .catch((error) => {
            hardError = error;
            finish();
        });
    });
}

/**
 * Rejoue la CLI tant que l'échec est transitoire et que rien n'a été transmis.
 */
async function runWithRetries(cliInput, requestId, handlers = {}) {
    const { shouldStop, ...attemptHandlers } = handlers;
    let attempt = null;
    let attemptCount = 0;
    for (let i = 0; ; i++) {
        attempt = await runAttempt(cliInput, attemptHandlers);
        attemptCount++;
        const retryable = !attempt.emitted &&
            !shouldStop?.() &&
            (isTransientResult(attempt.result) ||
                (!attempt.result && isRetryableHardError(attempt.hardError)));
        if (!retryable || i >= RETRY_DELAYS_MS.length)
            break;
        const delay = RETRY_DELAYS_MS[i];
        const reason = attempt.hardError?.message || transientReason(attempt.result);
        console.error(`[Retry] ${requestId} attempt ${i + 1} transient failure (${reason}); retrying in ${delay}ms`);
        await sleep(delay);
    }
    return { ...attempt, attempts: attemptCount };
}

function exhaustedError(attempt) {
    const detail = attempt.hardError?.message || transientReason(attempt.result);
    const tries = attempt.attempts || 1;
    return {
        message: `Claude CLI failed after ${tries} attempt${tries > 1 ? "s" : ""}: ${detail}`,
        type: "server_error",
        code: "upstream_transient_failure",
    };
}

/**
 * Handle streaming response (SSE)
 *
 * IMPORTANT: The Express req.on("close") event fires when the request body
 * is fully received, NOT when the client disconnects. For SSE connections,
 * we use res.on("close") to detect actual client disconnection.
 */
async function handleStreamingResponse(req, res, cliInput, requestId) {
    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Request-Id", requestId);
    // CRITICAL: Flush headers immediately to establish SSE connection
    // Without this, headers are buffered and client times out waiting
    res.flushHeaders();
    // Send initial comment to confirm connection is alive
    res.write(":ok\n\n");
    let isFirst = true;
    let lastModel = "claude-sonnet-4";
    let clientGone = false;
    let running = null;
    res.on("close", () => {
        clientGone = true;
        // Client disconnected before completion: stop the CLI.
        running?.kill();
    });
    const onDelta = (text) => {
        if (clientGone || res.writableEnded)
            return false;
        const chunk = {
            id: `chatcmpl-${requestId}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: lastModel,
            choices: [{
                    index: 0,
                    delta: {
                        role: isFirst ? "assistant" : undefined,
                        content: text,
                    },
                    finish_reason: null,
                }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        isFirst = false;
        return true;
    };
    const attempt = await runWithRetries(cliInput, requestId, {
        onDelta,
        onStart: (subprocess) => {
            running = subprocess;
            // Le client peut être parti pendant l'attente entre deux tentatives.
            if (clientGone)
                subprocess.kill();
        },
        onAssistant: (message) => {
            lastModel = message.message.model;
        },
        shouldStop: () => clientGone || res.writableEnded,
    });
    if (clientGone || res.writableEnded)
        return;
    // Échec transitoire non résorbé, ou plantage : erreur explicite plutôt
    // qu'un flux vide qui passerait pour une réponse.
    if (!attempt.emitted && (attempt.hardError || isFailedResult(attempt.result) || isTransientResult(attempt.result))) {
        res.write(`data: ${JSON.stringify({ error: exhaustedError(attempt) })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
    }
    res.write(`data: ${JSON.stringify(createDoneChunk(requestId, lastModel))}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
}

/**
 * Handle non-streaming response
 */
async function handleNonStreamingResponse(res, cliInput, requestId) {
    const attempt = await runWithRetries(cliInput, requestId);
    if (res.headersSent)
        return;
    if (!attempt.hardError && !isFailedResult(attempt.result) && !isTransientResult(attempt.result)) {
        res.json(cliResultToOpenai(attempt.result, requestId));
        return;
    }
    // Plus de 200 trompeur : l'appelant doit pouvoir distinguer une panne
    // d'une réponse du modèle.
    res.status(502).json({ error: exhaustedError(attempt) });
}

/**
 * Handle GET /v1/models
 *
 * Returns available models
 */
export function handleModels(_req, res) {
    res.json({
        object: "list",
        data: [
            {
                id: "claude-opus-4",
                object: "model",
                owned_by: "anthropic",
                created: Math.floor(Date.now() / 1000),
            },
            {
                id: "claude-sonnet-4",
                object: "model",
                owned_by: "anthropic",
                created: Math.floor(Date.now() / 1000),
            },
            {
                id: "claude-haiku-4",
                object: "model",
                owned_by: "anthropic",
                created: Math.floor(Date.now() / 1000),
            },
        ],
    });
}

/**
 * Handle GET /health
 *
 * Health check endpoint
 */
export function handleHealth(_req, res) {
    res.json({
        status: "ok",
        provider: "claude-code-cli",
        timestamp: new Date().toISOString(),
    });
}

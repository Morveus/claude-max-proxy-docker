/**
 * Converts OpenAI chat request format to Claude CLI input
 *
 * Remplacement complet du fichier upstream (claude-max-api-proxy/dist/adapter/openai-to-cli.js).
 * Ajouts par rapport à l'upstream :
 *   - content en tableau (format multimodal OpenAI) géré proprement
 *   - images data-URI écrites dans /tmp/vision puis lues par la CLI Claude
 *     via son outil Read (la CLI ne prend pas d'image dans le prompt texte)
 */
import { writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const MODEL_MAP = {
    // Direct model names
    "claude-opus-4": "opus",
    "claude-sonnet-4": "sonnet",
    "claude-haiku-4": "haiku",
    // With provider prefix
    "claude-code-cli/claude-opus-4": "opus",
    "claude-code-cli/claude-sonnet-4": "sonnet",
    "claude-code-cli/claude-haiku-4": "haiku",
    // Aliases
    "opus": "opus",
    "sonnet": "sonnet",
    "haiku": "haiku",
};

/**
 * Extract Claude model alias from request model string
 */
export function extractModel(model) {
    if (MODEL_MAP[model]) {
        return MODEL_MAP[model];
    }
    const stripped = model.replace(/^claude-code-cli\//, "");
    if (MODEL_MAP[stripped]) {
        return MODEL_MAP[stripped];
    }
    // Default to opus (Claude Max subscription)
    return "opus";
}

const VISION_DIR = process.env.VISION_DIR || "/tmp/vision";
const VISION_TTL_MS = 60 * 60 * 1000;
const IMAGE_EXT = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
};

// Écrit une image data-URI sur disque et purge les fichiers de plus d'une heure.
// Retourne le chemin du fichier, ou null si l'URL n'est pas un data-URI image.
function saveDataUriImage(url) {
    const m = /^data:(image\/[a-z0-9+.-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(url || "");
    if (!m) return null;
    const ext = IMAGE_EXT[m[1]] || "bin";
    mkdirSync(VISION_DIR, { recursive: true });
    try {
        const now = Date.now();
        for (const f of readdirSync(VISION_DIR)) {
            const p = join(VISION_DIR, f);
            try {
                if (now - statSync(p).mtimeMs > VISION_TTL_MS) unlinkSync(p);
            } catch { /* fichier déjà parti */ }
        }
    } catch { /* purge best-effort */ }
    const path = join(VISION_DIR, `${randomUUID()}.${ext}`);
    writeFileSync(path, Buffer.from(m[2].replace(/\s/g, ""), "base64"));
    return path;
}

// string | ContentPart[] -> { text, images[] }
function normalizeContent(content) {
    if (typeof content === "string") return { text: content, images: [] };
    if (Array.isArray(content)) {
        const texts = [];
        const images = [];
        for (const part of content) {
            if (!part) continue;
            if (part.type === "text" && part.text) texts.push(part.text);
            if (part.type === "image_url") {
                const saved = saveDataUriImage(part.image_url && part.image_url.url);
                if (saved) images.push(saved);
            }
        }
        return { text: texts.join("\n"), images };
    }
    return { text: String(content ?? ""), images: [] };
}

/**
 * Convert OpenAI messages array to a single prompt string for Claude CLI
 */
export function messagesToPrompt(messages) {
    const parts = [];
    for (const msg of messages) {
        const { text, images } = normalizeContent(msg.content);
        const body = images.length
            ? `${text}\n\n[Pièce(s) jointe(s) : avant de répondre, lis chacun de ces fichiers image avec l'outil Read pour voir la photo : ${images.join(", ")}]`
            : text;
        switch (msg.role) {
            case "system":
                parts.push(`<system>\n${body}\n</system>\n`);
                break;
            case "user":
                parts.push(body);
                break;
            case "assistant":
                parts.push(`<previous_response>\n${body}\n</previous_response>\n`);
                break;
        }
    }
    return parts.join("\n").trim();
}

/**
 * Convert OpenAI chat request to CLI input format
 */
export function openaiToCli(request) {
    return {
        prompt: messagesToPrompt(request.messages),
        model: extractModel(request.model),
        sessionId: request.user, // Use OpenAI's user field for session mapping
    };
}
//# sourceMappingURL=openai-to-cli.js.map

import { handleChatCompletions } from "./dist/server/routes.js";

function makeRes() {
  const r = {
    statusCode: 200, body: null, chunks: [], headersSent: false, writableEnded: false,
    _closeCbs: [],
    setHeader() {}, flushHeaders() { r.headersSent = true; },
    status(c) { r.statusCode = c; return r; },
    json(o) { r.headersSent = true; r.body = o; r.writableEnded = true; },
    write(s) { r.headersSent = true; r.chunks.push(s); return true; },
    end() { r.writableEnded = true; },
    on(ev, cb) { if (ev === "close") r._closeCbs.push(cb); },
  };
  return r;
}

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

async function run(name, scenario, body) {
  globalThis.__scenario = scenario;
  globalThis.__spawns = 0;
  const res = makeRes();
  await handleChatCompletions({ body }, res);
  console.log(`\n[${name}] status=${res.statusCode} spawns=${globalThis.__spawns}`);
  return res;
}

const NS = { messages: [{ role: "user", content: "hi" }] };
const ST = { messages: [{ role: "user", content: "hi" }], stream: true };

// 1. Succes immediat : pas de retry
let r = await run("succes immediat", [{ type: "ok", text: "bonjour" }], NS);
check("status 200", r.statusCode === 200);
check("une seule tentative", globalThis.__spawns === 1, `(${globalThis.__spawns})`);
check("contenu du modele", r.body?.choices?.[0]?.message?.content === "bonjour");

// 2. Transitoire puis succes : retry puis reponse reelle
r = await run("transitoire puis succes", [{ type: "transient" }, { type: "ok", text: "recupere" }], NS);
check("status 200", r.statusCode === 200);
check("deux tentatives", globalThis.__spawns === 2, `(${globalThis.__spawns})`);
check("contenu du modele, pas le message d erreur", r.body?.choices?.[0]?.message?.content === "recupere",
  JSON.stringify(r.body?.choices?.[0]?.message?.content));

// 3. Transitoire persistant : 502 apres 4 tentatives, jamais 200
r = await run("transitoire persistant", Array.from({ length: 8 }, () => ({ type: "transient" })), NS);
check("status 502", r.statusCode === 502, `(${r.statusCode})`);
check("quatre tentatives", globalThis.__spawns === 4, `(${globalThis.__spawns})`);
check("pas de faux contenu", !r.body?.choices);
check("erreur explicite", /OAuth session expired/.test(r.body?.error?.message || ""), r.body?.error?.message);

// 4. Echec non transitoire : pas de retry, mais pas de 200 trompeur non plus
r = await run("echec non transitoire", [{ type: "failedOther" }], NS);
check("status 502", r.statusCode === 502, `(${r.statusCode})`);
check("une seule tentative", globalThis.__spawns === 1, `(${globalThis.__spawns})`);

// 5. Vraie reponse qui parle d authentification : surtout pas de retry ni de 502
r = await run("reponse legitime mentionnant /login", [{ type: "okTalksAboutAuth" }], NS);
check("status 200", r.statusCode === 200, `(${r.statusCode})`);
check("une seule tentative", globalThis.__spawns === 1, `(${globalThis.__spawns})`);
check("contenu preserve", /run \/login/.test(r.body?.choices?.[0]?.message?.content || ""));

// 6. Erreur dure de spawn : retry
r = await run("erreur de spawn puis succes", [{ type: "hardError" }, { type: "ok", text: "ok apres crash" }], NS);
check("status 200", r.statusCode === 200);
check("deux tentatives", globalThis.__spawns === 2, `(${globalThis.__spawns})`);

// 7. Streaming : transitoire puis succes, le client ne voit qu un flux propre
r = await run("streaming transitoire puis succes", [{ type: "transient" }, { type: "ok", text: "salut", stream: true }], ST);
check("deux tentatives", globalThis.__spawns === 2, `(${globalThis.__spawns})`);
const joined = r.chunks.join("");
check("delta transmis", /salut/.test(joined));
check("aucune fuite du message d erreur", !/OAuth session expired/.test(joined));
check("flux termine", /\[DONE\]/.test(joined));

// 8. Streaming : echec persistant -> chunk error, pas un flux vide silencieux
r = await run("streaming echec persistant", Array.from({ length: 8 }, () => ({ type: "transient" })), ST);
check("quatre tentatives", globalThis.__spawns === 4, `(${globalThis.__spawns})`);
const j8 = r.chunks.join("");
check("chunk error present", /"error"/.test(j8), j8.slice(0, 120));
check("flux termine", /\[DONE\]/.test(j8));

// 9. Timeout : jamais rejoue, sinon le client attend 4 x 5 minutes
r = await run("timeout non rejoue", [{ type: "timeout" }, { type: "ok", text: "jamais atteint" }], NS);
check("une seule tentative", globalThis.__spawns === 1, `(${globalThis.__spawns})`);
check("status 502", r.statusCode === 502, `(${r.statusCode})`);
check("motif timeout remonte", /timed out/i.test(r.body?.error?.message || ""), r.body?.error?.message);

console.log(`\n=== ${pass} ok, ${fail} echecs ===`);
process.exit(fail === 0 ? 0 : 1);

import {
  PROVIDER,
  SDK,
  bootstrapProvider,
  buildModels,
  configModels,
  parseProtocolDocs,
} from "./models.mjs";
import { collapseResponse } from "./stream.mjs";
import { guardToolResponse } from "./tool-response.mjs";
import { CLIENT_UA, applyFingerprint, gatewayHeaders, sessionForConversation } from "../ofm/src/upstream.js";
import { normalizeResponse } from "../../src/response.mjs";

const DEFAULT_BASE = "https://opencode.ai/inference/v1";
const CATALOG = "https://models.opencode.ai/api.json";
const DOCS =
  "https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/zen.mdx";
const PATHS = { chat: "/chat/completions", responses: "/responses", anthropic: "/messages" };
// The v2 gate fingerprints the client on every header upstream.js sends; a
// second copy of that wire is what made this entry answer 403.

function httpURL(value) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Expected an HTTP(S) URL without credentials, query or fragment");
  }
  return url.href.replace(/\/+$/, "");
}

function requirePublic(auth) {
  if (auth?.type !== "api" || auth.key !== "public") {
    throw new Error(
      "OpenCode Zen Free uses the public credential. Enable its free access login method.",
    );
  }
}

async function readRemote(url, json, headers, callerSignal) {
  const timeout = AbortSignal.timeout(15000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  const response = await fetch(url, { headers, signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Model discovery returned HTTP ${response.status}`);
  }
  return json ? response.json() : response.text();
}

function normalizeTools(body, protocol) {
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    throw new Error("tools must be an array");
  }
  const declared = new Set();
  for (const tool of body.tools ?? []) {
    const name = protocol === "chat" ? tool?.function?.name : tool?.name;
    if (typeof name === "string") declared.add(name);
  }
  if (protocol === "chat" && Array.isArray(body.functions)) {
    for (const tool of body.functions) if (typeof tool?.name === "string") declared.add(tool.name);
  }
  const map = applyFingerprint(body, protocol === "responses" ? true : protocol === "anthropic" ? "claude" : false);
  const injected = new Set();
  const folded = new Map(map);
  for (const [sent, original] of map) {
    if (!declared.has(sent)) injected.add(sent);
    declared.add(original);
  }
  for (const tool of body.tools ?? []) {
    const name = protocol === "chat" ? tool?.function?.name : tool?.name;
    if (typeof name === "string" && !declared.has(name) && !map.has(name)) injected.add(name);
  }
  return { declared, injected, folded };
}

/** The conversation the caller names, or global when it names none. */
function sessionSeed(headers, body) {
  for (const name of [
    "x-opencode-session-id",
    "x-opencode-session",
    "x-session-affinity",
    "x-session-id",
    "conversation-id",
  ]) {
    const value = headers.get(name);
    if (value) return value;
  }
  if (typeof body.metadata?.session_id === "string") return body.metadata.session_id;
  const messages = body.messages ?? body.input;
  const first = Array.isArray(messages)
    ? messages.find((message) => message.role === "user")?.content
    : messages;
  return first ? JSON.stringify(first) : "global";
}

async function server(_input, options = {}) {
  const baseURL = httpURL(options.baseURL ?? DEFAULT_BASE);
  const catalogURL = httpURL(options.catalogURL ?? CATALOG);
  const docsURL = httpURL(options.docsURL ?? DOCS);
  let known = buildModels(Object.keys(bootstrapProvider.models), bootstrapProvider, {}, baseURL);
  let metadata = bootstrapProvider;
  let protocols = {};
  let listed = false;

  async function discover(signal) {
    const headers = { authorization: "Bearer public", "x-opencode-client": "cli" };
    const [listing, catalog, docs] = await Promise.allSettled([
      readRemote(`${baseURL}/models`, true, headers, signal),
      readRemote(catalogURL, true, undefined, signal),
      readRemote(docsURL, false, undefined, signal),
    ]);
    signal?.throwIfAborted();
    let partial = false;
    if (catalog.status === "fulfilled" && catalog.value?.opencode?.models) {
      metadata = catalog.value.opencode;
    } else {
      partial = true;
    }
    if (docs.status === "fulfilled" && Object.keys(parseProtocolDocs(docs.value)).length) {
      protocols = parseProtocolDocs(docs.value);
    } else {
      partial = true;
    }
    if (listing.status !== "fulfilled" || !Array.isArray(listing.value?.data)) {
      const fallback = { ...known };
      fallback[Symbol.for("magpie.fellBack")] = true;
      return fallback;
    }
    const ids = listing.value.data.map((item) => item.id);
    const discovered = buildModels(ids, metadata, protocols, baseURL);
    if (partial) {
      // Preserve previously verified models only while they remain in the live catalog.
      for (const id of ids) {
        if (!discovered[id] && !metadata.models?.[id] && !protocols[id] && known[id]) {
          discovered[id] = known[id];
        }
      }
      discovered[Symbol.for("magpie.fellBack")] = true;
    }
    known = discovered;
    listed = true;
    return discovered;
  }

  return {
    async config(cfg) {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= {
        name: "OpenCode Zen Free",
        npm: SDK.chat,
        api: baseURL,
        models: configModels(known),
      };
    },
    auth: {
      provider: PROVIDER,
      icon: "https://opencode.ai/favicon-v3.ico",
      maxConcurrency: 2,
      methods: [
        {
          type: "api",
          label: "Zen 免费访问（密钥填写 public）",
          placeholder: "public",
          async authorize() {
            return { type: "success", key: "public" };
          },
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth();
        if (!auth) return {};
        requirePublic(auth);
        return {
          baseURL,
          apiKey: "public",
          async fetch(input, init) {
            requirePublic(await getAuth());
            const request = new Request(input, init);
            const protocol = Object.keys(PATHS).find(
              (key) => request.url === `${baseURL}${PATHS[key]}`,
            );
            if (!protocol || request.method !== "POST")
              throw new Error("Unsupported Zen endpoint or method");
            request.signal.throwIfAborted();
            const body = await request.json();
            if (!body || typeof body !== "object" || Array.isArray(body))
              throw new Error("Expected a JSON request object");
            if (!listed && !Object.hasOwn(known, body.model)) {
              await discover(request.signal);
            }
            const model = known[body.model];
            if (!model || model.api.npm !== SDK[protocol]) {
              throw new Error(
                "Model is not an available free model for this protocol. Refresh the model list.",
              );
            }
            const streaming = body.stream === true;
            body.stream = true;
            const toolPolicy = normalizeTools(body, protocol);
            if (protocol === "chat")
              body.stream_options = { ...body.stream_options, include_usage: true };
            // One wire, one source: v2 refuses x-opencode-request, demands
            // both session headers and a versioned client token.
            const session = sessionForConversation(sessionSeed(request.headers, body));
            const headers = new Headers(gatewayHeaders({ session, stream: true }));
            // A caller that names its project keeps it; otherwise the v2 rule:
            // a git checkout's id, else global.
            const callerProject = request.headers.get("x-opencode-project");
            const gitProject = _input?.project?.vcs === "git" ? _input.project.id : undefined;
            headers.set("x-opencode-project", callerProject ?? gitProject ?? "global");
            headers.set("user-agent", CLIENT_UA);
            if (protocol === "anthropic") {
              headers.delete("authorization");
              headers.set("x-api-key", "public");
              headers.set("anthropic-version", "2023-06-01");
            }
            const response = await fetch(request.url, {
              method: "POST",
              headers,
              body: JSON.stringify(body),
              signal: request.signal,
              redirect: "error",
            });
            const guarded = await guardToolResponse(await normalizeResponse(response), protocol, toolPolicy);
            return streaming ? guarded : collapseResponse(guarded, protocol);
          },
        };
      },
      async usage() {
        return { plan: "OpenCode Zen Free", windows: [] };
      },
    },
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (!auth) return provider.models;
        requirePublic(auth);
        return discover();
      },
    },
    async "chat.headers"(input, output) {
      if (![PROVIDER, `${PROVIDER}-plugin`].includes(input.model?.providerID) || !input.sessionID)
        return;
      output.headers["x-session-id"] = input.sessionID;
      output.headers["x-opencode-session"] = input.sessionID;
      output.headers["x-opencode-session-id"] = input.sessionID;
      output.headers["x-session-affinity"] = input.sessionID;
    },
  };
}

export default { id: PROVIDER, server };

